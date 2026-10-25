#!/bin/sh
set -eu

# Use the HTTP server's kernel client, so this also catches auth/protocol regressions.
# Busy kernels may have no idle slots; process health still has to survive the update.
probe() {
  docker exec "$CONTAINER" node --input-type=module -e '
    const [mode, target, baseline = "[]"] = process.argv.slice(1)
    const port = process.env.PORT || "8787"
    const base = `http://127.0.0.1:${port}`
    const key = process.env.KIN_API_KEY || process.env.VM2API_API_KEY || ""
    async function json(path) {
      const res = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(12000),
      })
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
      const body = await res.json()
      return body.data || body
    }
    function kernelHealthy(detail) {
      const kernel = detail.kernel
      const health = kernel?.codex_health || kernel?.rust_health || kernel?.go_health
      return health?.status === 200 && health.process_up !== false && health.healthy !== false
    }
    function guardRequired(guards, proxy) {
      const required = proxy && Object.hasOwn(proxy, "required") ? proxy.required : guards.required
      if (typeof required !== "boolean") throw new Error("Invalid proxy guard requirement")
      return required
    }
    function verifySlot(saved, detail, guards) {
      const vm = detail.vm
      if (!saved?.id || typeof saved.schedulable !== "boolean") throw new Error("Invalid slot baseline")
      if (!kernelHealthy(detail)) throw new Error(`Previously healthy slot ${saved.id} failed kernel verification`)
      if (vm?.status !== "running") throw new Error(`Slot ${saved.id} is not running; use native /start only after reviewing its exit guard`)
      if (vm.schedulable !== saved.schedulable) throw new Error(`Slot ${saved.id} is not schedulable as recorded`)
      if ((vm.proxy_id || vm.proxy?.id || null) !== saved.proxy_id ||
          (vm.max_concurrency ?? null) !== saved.max_concurrency) throw new Error(`Slot ${saved.id} proxy or concurrency changed`)
      const proxy = guards.proxies?.find(p => p.id === saved.proxy_id)
      if (saved.guard_required !== guardRequired(guards, proxy) ||
          (typeof saved.guard_default_required === "boolean" && saved.guard_default_required !== guards.required)) {
        throw new Error("Exit guard requirement changed")
      }
      if (saved.guard_required && saved.schedulable) {
        const state = proxy?.state
        const age = Date.now() - Date.parse(state?.checked_at)
        if (!saved.expected_ip || proxy?.expected_ip !== saved.expected_ip ||
            state?.expected_ip !== saved.expected_ip || state?.observed_ip !== saved.expected_ip ||
            state?.revision !== proxy?.revision || state?.ready !== true || state?.latched !== false ||
            !Number.isFinite(age) || age < 0 || age > 120000) {
          throw new Error(`Slot ${saved.id} exit guard is blocked or changed; operator review required, never auto-rearm`)
        }
      }
    }
    try {
      if (mode === "snapshot") {
        const list = await json("/api/panel/vms")
        const vms = Array.isArray(list) ? list : list.items
        if (!Array.isArray(vms)) throw new Error("Invalid slot list")
        const healthy = []
        const guards = await json("/api/panel/proxy-exit-guard")
        if (typeof guards.required !== "boolean" || !Array.isArray(guards.proxies)) throw new Error("Invalid exit guard response")
        for (const vm of vms.filter(vm => vm.status === "running")) {
          const detail = await json(`/api/panel/vms/${encodeURIComponent(vm.id)}`)
          if (kernelHealthy(detail)) {
            const current = detail.vm
            const proxyId = current?.proxy_id || current?.proxy?.id || null
            const guard = guards.proxies?.find(p => p.id === proxyId)
            const saved = {
              id: vm.id, schedulable: vm.schedulable !== false,
              proxy_id: proxyId, max_concurrency: current?.max_concurrency ?? null,
              guard_required: guardRequired(guards, guard), guard_default_required: guards.required,
              expected_ip: guard?.expected_ip || null,
            }
            verifySlot(saved, detail, guards)
            healthy.push(saved)
          }
        }
        console.log(JSON.stringify(healthy))
      } else {
        const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
        if (!health.ok) throw new Error(`Backend health: HTTP ${health.status}`)
        if (mode === "verify") {
          const version = await json("/api/panel/version")
          if (version.current_tag !== target) throw new Error(`Backend still at ${version.current_tag}`)
        }
        const guards = await json("/api/panel/proxy-exit-guard")
        if (typeof guards.required !== "boolean" || !Array.isArray(guards.proxies)) throw new Error("Invalid exit guard response")
        const saved = JSON.parse(baseline)
        if (!Array.isArray(saved)) throw new Error("Invalid slot baseline")
        for (const slot of saved) {
          verifySlot(slot, await json(`/api/panel/vms/${encodeURIComponent(slot.id)}`), guards)
        }
      }
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  ' "$@"
}

# These modes only read native APIs; they never start slots or clear a guard latch.
case "${1:-}" in
  --snapshot-slots)
    CONTAINER=$2
    probe snapshot ""
    exit 0
    ;;
  --verify-slots)
    CONTAINER=$2
    probe slots "" "$(cat "$3")"
    echo "Slot state, proxy, concurrency and exit guard verified"
    exit 0
    ;;
esac

ROOT=$1
PROJECT=$2
CONTAINER=$3
PREVIOUS_ID=$4
TAG=$5
ARCH=$6
shift 6
cd "$ROOT"

COMPOSE_FILE_LIST=''
for file do
  if [ -n "$COMPOSE_FILE_LIST" ]; then COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST:"; fi
  COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST$file"
done

compose() {
  COMPOSE_FILE="$COMPOSE_FILE_LIST" docker compose \
    --project-directory "$ROOT" --project-name "$PROJECT" "$@"
}

# Let the update request return before replacing its own HTTP server.
sleep 2
BASELINE=$(probe snapshot "$TAG")
echo "Recording healthy slot kernels before upgrade: $BASELINE"
if [ -d .git ]; then
  if [ "$ARCH" = arm64 ]; then
    case ":$COMPOSE_FILE_LIST:" in
      *":$ROOT/docker-compose.arm64.yml:"*) ;;
      *) echo 'ARM64 source install lacks docker-compose.arm64.yml' >&2; exit 1 ;;
    esac
  fi
  export GIT_TERMINAL_PROMPT=0
  command -v git >/dev/null || apk add --no-cache git >/dev/null
  git config --global --add safe.directory "$ROOT"
  # History was rewritten once to drop build artifacts; --force lets old clones take the new tags.
  git fetch --force --tags origin
  # Routing and interception rules are tracked defaults but live operator config.
  CONFIG_BACKUP=$(mktemp -d)
  if [ -d src/config ]; then cp -a src/config "$CONFIG_BACKUP/config"; fi
  restore_config() {
    if [ -d "$CONFIG_BACKUP/config" ]; then
      mkdir -p src/config
      cp -a "$CONFIG_BACKUP/config/." src/config/
    fi
    rm -rf "$CONFIG_BACKUP"
  }
  if ! git checkout -f --detach "$TAG"; then
    restore_config
    exit 1
  fi
  restore_config
  chmod 755 bin/kin-* 2>/dev/null || true
  grep -q '^!CHANGELOG.md$' .dockerignore 2>/dev/null || printf '\n!CHANGELOG.md\n' >> .dockerignore
  if [ "$ARCH" = amd64 ]; then
    case ":$COMPOSE_FILE_LIST:" in
      *":$ROOT/docker-compose.build.yml:"*) ;;
      *) COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST:$ROOT/docker-compose.build.yml" ;;
    esac
  fi
  compose build vm2api
else
  IMAGE_TAG=$TAG
  [ "$ARCH" != arm64 ] || IMAGE_TAG=$TAG-arm64
  touch .env
  if grep -q '^VM2API_IMAGE_TAG=' .env; then
    sed -i.bak "s|^VM2API_IMAGE_TAG=.*|VM2API_IMAGE_TAG=$IMAGE_TAG|" .env
    rm -f .env.bak
  else
    printf '\nVM2API_IMAGE_TAG=%s\n' "$IMAGE_TAG" >> .env
  fi
  compose pull vm2api
fi

compose up -d --no-deps --force-recreate vm2api
CURRENT_ID=$(docker inspect --format '{{.Id}}' "$CONTAINER")
if [ "$CURRENT_ID" = "$PREVIOUS_ID" ]; then
  echo 'Compose did not replace the running control plane' >&2
  exit 1
fi

# Check the backend and previously healthy slots, rather than trusting VERSION.
attempt=0
while [ "$attempt" -lt 45 ]; do
  if probe verify "$TAG" "$BASELINE"; then
    # Replace the Go worker/egress payloads in-place; no VM/container rebuild.
    # Older control-plane images may not carry the helper yet; retry on the
    # next image update instead of invalidating an otherwise verified upgrade.
    if ! docker exec "$CONTAINER" test -f /opt/vm2api/scripts/fleet-services.mjs >/dev/null 2>&1; then
      echo "Go service refresh helper is not present in the control plane; retry after the next image update" >&2
    elif ! docker exec "$CONTAINER" node /opt/vm2api/scripts/fleet-services.mjs; then
      echo "Go service-only update failed; inspect the per-slot report" >&2
      exit 1
    fi
    # A helper refresh can stop a slot after the first successful probe.
    probe verify "$TAG" "$BASELINE" || exit 1
    [ -d .git ] || printf '%s\n' "${TAG#v}" > VERSION
    echo "Control plane restarted and verified at $TAG"
    echo "Previously healthy slot kernels verified: $BASELINE"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done
echo "Control plane or previously healthy slot kernels did not become healthy at $TAG" >&2
exit 1
