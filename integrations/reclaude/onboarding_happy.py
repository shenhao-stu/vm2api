"""Gateway-host side of onboarding a native Relay seat.

Every seat gets its own tunnel, its own gateway container, its own private route and its own
console entry, each cloned from one healthy template seat with only the identity replaced.
The text functions at the top are pure, so tests can prove they reproduce a template.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

SYSTEMD = Path("/etc/systemd/system")
SEAT = re.compile(r"[0-9a-f]{8}")
FORWARD = re.compile(r"-L 127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)")


class StepFailed(Exception):
    """A step did not reach its verified end state. `code` is shown to an administrator."""

    def __init__(self, code, detail=""):
        self.code, self.detail = code, str(detail)[:300]
        super().__init__(code)


def require(condition, code, detail=""):
    if not condition:
        raise StepFailed(code, detail)


# ---------------------------------------------------------------- pure text

def substitute(text, pairs):
    """Replace every old value in one pass. Numbers only match as whole numbers."""
    patterns, replacement = [], {}
    for old, new in sorted(pairs, key=lambda pair: -len(str(pair[0]))):
        numeric = str(old).isdigit()
        patterns.append(r"(?<![0-9])" + str(old) + r"(?![0-9])" if numeric else re.escape(str(old)))
        replacement[str(old)] = str(new)
    return re.sub("|".join(patterns), lambda match: replacement[match.group(0)], text)


def unit_body(text):
    """A unit file without the path comment `systemctl cat` prints above it."""
    return "\n".join(line for line in text.splitlines() if not line.startswith("# /")) + "\n"


def template_ports(link_unit, environment):
    """(tunnel port, worker port on the container host, gateway port) of the template seat."""
    forwards = FORWARD.findall(link_unit)
    require(len(forwards) == 1, "template_link_unexpected")
    return int(forwards[0][0]), int(forwards[0][1]), int(environment["PORT"])


def seat_locations(nginx, seat):
    """The private route of one seat: its `models` and `messages` locations, in file order."""
    blocks = []
    for verb in ("models", "messages"):
        pattern = r"^    location = /reclaude/v1/native-" + re.escape(seat) + r"/v1/" + verb + r" \{\n.*?^    \}\n"
        found = re.findall(pattern, nginx, re.MULTILINE | re.DOTALL)
        require(len(found) == 1, "template_route_unexpected", verb)
        blocks.append(found[0])
    return blocks


def seat_block(nginx, template_seat, seat):
    """The template's two locations under the new identity, between markers that name the seat."""
    body = substitute("".join(seat_locations(nginx, template_seat)), [(template_seat, seat)])
    require(template_seat not in body and body.count(seat) == 6, "route_render_unexpected")
    for needed in ("proxy_next_upstream off;", "proxy_buffering off;", f"/{seat}/catalog-ready)", f"/{seat}/accepted)",
                   "deny all;"):
        require(needed in body, "route_render_unexpected", needed)
    return f"    # BEGIN vm2api onboarded seat {seat}\n{body}    # END vm2api onboarded seat {seat}\n"


def insert_seat_block(nginx, template_seat, seat):
    """Put the new seat's block right above the template seat's route (and its comment line)."""
    block = seat_block(nginx, template_seat, seat)
    if block in nginx:
        return nginx
    require(f"native-{seat}/" not in nginx, "route_differs_from_template")
    first = seat_locations(nginx, template_seat)[0]
    at = nginx.index(first)
    before = nginx.rfind("\n", 0, at - 1) + 1
    if nginx[before:at].lstrip().startswith("#"):
        at = before
    return nginx[:at] + block + nginx[at:]


def remove_seat_block(nginx, seat):
    pattern = (r"^    # BEGIN vm2api onboarded seat " + seat + r"\n.*?^    # END vm2api onboarded seat " + seat + r"\n")
    result = re.sub(pattern, "", nginx, flags=re.MULTILINE | re.DOTALL)
    require(f"native-{seat}/" not in result, "route_not_removed")
    return result


def gateway_shape(inspection):
    """The settings a cloned gateway container must share with its template."""
    host, config = inspection["HostConfig"], inspection["Config"]
    return {
        "image": inspection["Image"], "entrypoint": config.get("Entrypoint"), "command": config.get("Cmd"),
        "user": config.get("User"), "network": host["NetworkMode"], "restart": host["RestartPolicy"]["Name"],
        "read_only": host.get("ReadonlyRootfs"), "cap_drop": host.get("CapDrop"), "security": host.get("SecurityOpt"),
        "pids": host.get("PidsLimit"), "memory": host.get("Memory"), "swap": host.get("MemorySwap"),
        "cpus": host.get("NanoCpus"), "tmpfs": host.get("Tmpfs"),
        "shared_mounts": sorted([m["Source"], m["Destination"], m["RW"]] for m in inspection["Mounts"]
                                if m["Destination"].startswith("/opt/") and not m["Destination"].endswith("gateway-v2.public.json")),
        "own_mounts": sorted(m["Destination"] for m in inspection["Mounts"]
                             if not m["Destination"].startswith("/opt/") or m["Destination"].endswith("gateway-v2.public.json")),
    }


def gateway_arguments(inspection, name, seat, state, environment_file):
    """`docker run` arguments that rebuild the template gateway for another seat."""
    host, config = inspection["HostConfig"], inspection["Config"]
    arguments = ["--name", name, "--restart", host["RestartPolicy"]["Name"], "--network", host["NetworkMode"],
                 "--label", "vm2api.seat.org=" + seat, "--memory", str(host["Memory"]), "--memory-swap", str(host["MemorySwap"]),
                 "--cpus", str(host["NanoCpus"] / 1e9), "--pids-limit", str(host["PidsLimit"])]
    if host.get("ReadonlyRootfs"):
        arguments.append("--read-only")
    for path, options in (host.get("Tmpfs") or {}).items():
        arguments += ["--tmpfs", f"{path}:{options}"]
    for capability in host.get("CapDrop") or []:
        arguments += ["--cap-drop", capability]
    for option in host.get("SecurityOpt") or []:
        arguments += ["--security-opt", option]
    arguments += ["--env-file", str(environment_file), "-v", f"{state}:/state",
                  "-v", f"{state}/gateway-v2.public.json:/opt/vm2api/src/config/gateway-v2.public.json:rw"]
    for mount in inspection["Mounts"]:
        target = mount["Destination"]
        if target.startswith("/opt/") and not target.endswith("gateway-v2.public.json"):
            require(not mount["RW"] and mount["Type"] == "bind", "template_mount_unsupported", target)
            arguments += ["--mount", f"type=bind,src={mount['Source']},dst={target},readonly"]
    entrypoint = config.get("Entrypoint") or []
    require(len(entrypoint) == 1, "template_entrypoint_unsupported")
    return arguments + ["--entrypoint", entrypoint[0], inspection["Image"], *(config.get("Cmd") or [])]


def manager_config(template, seat, name, facts, paths, sub_control_command):
    """The console entry of a seat: the same boundary and commands as the template, scoped to this seat."""
    remote = shlex.join(["python3", facts["nas_agent"], facts["nas_config"]])
    return {
        "id": "reclaude-agentnas-" + seat, "name": name, "node": template["node"],
        "binding": facts["binding"], "sub_account": facts["sub_account"],
        "concurrency": template["concurrency"], "models": template["models"],
        "state_dir": str(paths["manager_state"]), "guard_source": "runtime",
        "guard_file": facts["guard_file"], "guard_revision": facts["guard_revision"], "expected_ip": facts["expected_ip"],
        "runtime_command": template["runtime_command"][:-1] + [remote],
        "sub_command": [*sub_control_command, "seat-control " + seat],
        "origin": template["origin"], "panel_me_url": template["panel_me_url"],
        "usage_ledger": {"path": str(paths["state"] / "data/kin.db"), "account_id": facts["ledger_account"]},
    }


# ---------------------------------------------------------------- host

def run(arguments, timeout=40):
    done = subprocess.run(arguments, capture_output=True, text=True, timeout=timeout)
    if done.returncode:
        raise StepFailed("command_failed", f"{Path(arguments[0]).name} {' '.join(arguments[1:3])}: {done.stderr.strip()[-160:]}")
    return done.stdout.strip()


def http(address, path, secret=None, admin=False, body=None, timeout=5):
    headers = {"Content-Type": "application/json"}
    if secret is not None:
        headers["Authorization" if admin else "x-api-key"] = ("Bearer " + secret) if admin else secret
    call = urllib.request.Request(address + path, headers=headers, data=None if body is None else json.dumps(body).encode())
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(call, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(200000)
    try:
        return response.status, json.loads(raw)
    except ValueError:
        return response.status, {}


def wait_for(probe, attempts=60, pause=.5):
    """Call `probe` until it returns something truthy; network errors count as not yet."""
    for _ in range(attempts):
        try:
            value = probe()
            if value:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(pause)
    return None


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_private(path, text):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as file:
        file.write(text)


class Happy:
    """Steps that run on the gateway host as root. Each one is safe to run again."""

    def __init__(self, config, root):
        self.config, self.root = config, Path(root)

    # ------------------------------------------------------------ names

    def paths(self, seat):
        require(isinstance(seat, str) and SEAT.fullmatch(seat), "invalid_seat")
        private = self.root / "seats" / seat
        return {
            "private": private, "state": private / "state", "environment": private / "env.private",
            "record": private / "happy.json", "client_key": private / "client.key",
            "manager_config": self.root / "manager-configs" / (seat + ".json"),
            "manager_state": self.root / "manager-state" / seat,
            "ingress": Path(self.config["ingress_root"]) / seat,
            "container": f"vm2api-reclaude-{seat}-gateway",
            "link": f"reclaude-seat-{seat}-private-link.service",
            "socket": f"reclaude-seat-{seat}-gateway.socket",
            "proxy": f"reclaude-seat-{seat}-gateway.service",
        }

    def template(self):
        seat = self.config["template_seat"]
        container = json.loads(run(["docker", "inspect", f"vm2api-reclaude-{seat}-gateway"]))[0]
        state = Path(next(m["Source"] for m in container["Mounts"] if m["Destination"] == "/state"))
        environment = dict(line.split("=", 1) for line in (state.parent / "env.private").read_text().splitlines())
        units = {kind: unit_body((SYSTEMD / name).read_text()) for kind, name in (
            ("link", f"reclaude-seat-{seat}-private-link.service"), ("socket", f"reclaude-seat-{seat}-gateway.socket"),
            ("proxy", f"reclaude-seat-{seat}-gateway.service"))}
        return {"seat": seat, "container": container, "state": state, "environment": environment, "units": units,
                "ports": template_ports(units["link"], environment),
                "manager": json.loads(Path(self.config["template_manager"]).read_text())}

    def listening(self):
        return {int(port) for port in re.findall(r":(\d+)\s", run(["ss", "-Hlnt"]))}

    def allocate(self, seat):
        """A free (tunnel, gateway) port pair that no other onboarded seat has recorded."""
        used = set()
        for path in (self.root / "seats").glob("*/happy.json"):
            # An abandoned seat keeps its folder under another name; its ports are free again.
            if SEAT.fullmatch(path.parent.name):
                record = read_json(path, {})
                used |= {record.get("link"), record.get("gateway")}
        busy = self.listening() | used
        for index in range(self.config["port_count"]):
            link, gateway = self.config["port_first"] + 10 * index, self.config["port_first"] + 10 * index + 5
            if not {link, gateway} & busy:
                return {"seat": seat, "link": link, "gateway": gateway}
        raise StepFailed("no_free_port")

    def install_unit(self, name, text):
        target = SYSTEMD / name
        if target.exists():
            require(not target.is_symlink() and target.read_text() == text, "unit_differs", name)
            return False
        with open(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644), "w") as file:
            file.write(text)
        return True

    # ------------------------------------------------------------ nginx

    def nginx_text(self):
        return Path(self.config["nginx_conf"]).read_text()

    def nginx_swap(self, expected, target):
        config = Path(self.config["nginx_conf"])
        status = config.stat()
        handle, name = tempfile.mkstemp(prefix=".relay-onboarding-", dir=config.parent)
        try:
            with os.fdopen(handle, "wb") as file:
                os.fchown(file.fileno(), status.st_uid, status.st_gid)
                os.fchmod(file.fileno(), status.st_mode & 0o777)
                file.write(target.encode())
                file.flush()
                os.fsync(file.fileno())
            require(config.read_text() == expected, "nginx_changed_concurrently")
            os.replace(name, config)
        finally:
            Path(name).unlink(missing_ok=True)

    def nginx_apply(self, change):
        """Edit the site file under its lock, validate, reload, and restore the old file on any failure."""
        with open(self.config["nginx_lock"], "a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise StepFailed("nginx_busy") from None
            run(["nginx", "-t"], 15)
            old = self.nginx_text()
            new = change(old)
            if new == old:
                return False
            backup = self.root / "nginx-backups" / ("vm2api." + hashlib.sha256(old.encode()).hexdigest()[:16] + ".private")
            if not backup.exists():
                write_private(backup, old)
            self.nginx_swap(old, new)
            try:
                run(["nginx", "-t"], 15)
                run(["systemctl", "reload", "nginx"], 30)
            except Exception:
                self.nginx_swap(new, old)
                run(["nginx", "-t"], 15)
                run(["systemctl", "reload", "nginx"], 30)
                raise StepFailed("nginx_rejected_route") from None
            return True

    def route_status(self, seat, path="/v1/models", key=None):
        return http(self.config["private_listener"], f"/reclaude/v1/native-{seat}{path}", key)

    # ------------------------------------------------------------ steps

    def preflight(self):
        """Read-only: the template is healthy and can be reproduced, and this host has room."""
        template = self.template()
        require(template["container"]["State"]["Running"], "template_gateway_not_running")
        nginx = self.nginx_text()
        sample = "0" * 8
        require(sample not in nginx, "sample_seat_present")
        block = seat_block(nginx, template["seat"], sample)
        require(remove_seat_block(insert_seat_block(nginx, template["seat"], sample), sample) == nginx, "route_edit_not_reversible")
        run(["nginx", "-t"], 15)
        status, _ = self.route_status(template["seat"])
        require(status == 401, "private_listener_unexpected", status)
        free = int(re.search(r"MemAvailable:\s+(\d+)", Path("/proc/meminfo").read_text()).group(1))
        require(free >= self.config["min_free_kb"], "gateway_host_memory_low", f"{free // 1024} MiB available")
        route = read_json(template["state"] / "src/config/routing.json", {})
        require(route.get("failover", {}).get("max_total_attempts") == 1, "template_routing_changed")
        manager = template["manager"]
        require(manager["runtime_command"][0] == "ssh" and "StrictHostKeyChecking=yes" in manager["runtime_command"],
                "template_manager_changed")
        self.allocate(sample)
        gateway_arguments(template["container"], "sample", sample, "/sample", "/sample/env")
        return {"route_lines": block.count("\n"), "memory_available_mb": free // 1024}

    def gateway(self, seat, binding, nas_port, worker_key):
        """Tunnel to the worker, a dedicated gateway container, and the socket nginx will use."""
        paths, template = self.paths(seat), self.template()
        require(not (paths["private"] / "live.marker").exists(), "seat_is_live")
        paths["private"].mkdir(mode=0o700, parents=True, exist_ok=True)
        record = read_json(paths["record"])
        if record is None:
            record = self.allocate(seat)
            write_private(paths["record"], json.dumps(record))
        old_link, old_worker, old_gateway = template["ports"]
        pairs = [(template["seat"], seat), (old_link, record["link"]), (old_gateway, record["gateway"])]

        link_unit = FORWARD.sub(f"-L 127.0.0.1:{record['link']}:127.0.0.1:{int(nas_port)}",
                                substitute(template["units"]["link"], [(template["seat"], seat)]))
        if self.install_unit(paths["link"], link_unit):
            run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "--now", paths["link"]], 60)
        backend = f"http://127.0.0.1:{record['link']}"
        health = wait_for(lambda: http(backend, "/healthz")[1].get("ok"))
        require(health, "worker_unreachable_through_tunnel")

        names = run(["docker", "ps", "-a", "--format", "{{.Names}}"]).split()
        if not paths["environment"].exists():
            require(paths["container"] not in names and not paths["state"].exists(), "gateway_state_unexpected")
            (paths["state"] / "src/config").mkdir(mode=0o700, parents=True)
            for name in ("src/config/routing.json", "gateway-v2.public.json"):
                write_private(paths["state"] / name, (template["state"] / name).read_text())
            # The template's own settings, with fresh secrets and this seat's port.
            environment = {**template["environment"],
                           "VM2API_ADMIN_PASSWORD": secrets.token_urlsafe(32), "VM2API_API_KEY": secrets.token_urlsafe(40),
                           "VM2API_DB_SECRET": secrets.token_hex(32), "PORT": str(record["gateway"]),
                           "PUBLIC_BASE_URL": f"http://127.0.0.1:{record['gateway']}"}
            write_private(paths["client_key"], secrets.token_urlsafe(42))
            write_private(paths["environment"], "".join(f"{key}={value}\n" for key, value in environment.items()))
        environment = dict(line.split("=", 1) for line in paths["environment"].read_text().splitlines())
        require(environment["PORT"] == str(record["gateway"]) and environment["HOST"] == "127.0.0.1", "gateway_environment_unexpected")

        if paths["container"] not in names:
            free = int(re.search(r"MemAvailable:\s+(\d+)", Path("/proc/meminfo").read_text()).group(1))
            require(free >= self.config["min_free_kb"], "gateway_host_memory_low")
            require(record["gateway"] not in self.listening(), "gateway_port_taken")
            run(["docker", "run", "-d", *gateway_arguments(template["container"], paths["container"], seat,
                                                              paths["state"], paths["environment"])], 90)
        own = json.loads(run(["docker", "inspect", paths["container"]]))[0]
        if not own["State"]["Running"]:
            run(["docker", "start", paths["container"]], 60)
        require(gateway_shape(own) == gateway_shape(template["container"])
                and own["Config"]["Labels"].get("vm2api.seat.org") == seat, "container_shape_mismatch")

        address, admin = environment["PUBLIC_BASE_URL"], environment["VM2API_API_KEY"]

        def panel(path, body=None):
            status, data = http(address, "/api/panel/" + path, admin, True, body)
            require(status in (200, 201), "gateway_admin_failed", f"{path} HTTP {status}")
            return data

        require(wait_for(lambda: http(address, "/api/panel/api-endpoints", admin, True)[0] == 200), "gateway_not_started")
        client = paths["client_key"].read_text().strip()
        require(len({client, worker_key}) == 2 and len(worker_key) >= 32, "relay_keys_unexpected")
        if not panel("api-endpoints")["items"]:
            panel("api-endpoints", {"name": "AgentNAS " + seat, "kind": "custom", "protocol": "anthropic", "base_url": backend,
                                    "auth_scheme": "authorization_bearer", "models": [{"name": model} for model in template["manager"]["models"]],
                                    "api_key_entries": [{"api_key": worker_key}]})
        endpoints = panel("api-endpoints")["items"]
        require(len(endpoints) == 1 and endpoints[0]["base_url"].rstrip("/") == backend, "gateway_endpoint_unexpected")
        key_name = f"Sub2API seat {seat} device {int(binding)}"
        if not panel("api-keys")["keys"]:
            panel("api-keys", {"name": key_name, "custom_key": client, "category": "api",
                               "max_concurrency": template["manager"]["concurrency"], "quota_requests": 0})
        keys = panel("api-keys")["keys"]
        require(len(keys) == 1 and keys[0]["name"] == key_name
                and keys[0]["max_concurrency"] == template["manager"]["concurrency"], "gateway_key_unexpected")
        right, catalog = http(address, "/v1/models", client)
        wrong, _ = http(address, "/v1/models", secrets.token_urlsafe(42))
        anonymous, _ = http(address, "/v1/models")
        require((right, wrong, anonymous) == (200, 401, 401)
                and set(template["manager"]["models"]) <= {model["id"] for model in catalog.get("data", [])},
                "gateway_catalog_unexpected", (right, wrong, anonymous))
        entries = endpoints[0].get("api_key_entries") or []
        require(len(entries) == 1 and isinstance(entries[0].get("id"), str), "gateway_ledger_account_unknown")

        root = Path(self.config["ingress_root"])
        require(root.is_dir() and not root.is_symlink() and root.stat().st_uid == 0, "ingress_root_unexpected")
        paths["ingress"].mkdir(mode=0o711, exist_ok=True)
        paths["ingress"].chmod(0o711)
        changed = self.install_unit(paths["socket"], substitute(template["units"]["socket"], pairs))
        changed |= self.install_unit(paths["proxy"], substitute(template["units"]["proxy"], pairs))
        if changed:
            run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "--now", paths["socket"]], 60)
        code = run(["curl", "--max-time", "5", "--unix-socket", str(paths["ingress"] / "gateway.sock"), "-o", "/dev/null",
                    "-sS", "-w", "%{http_code}", "http://localhost/v1/models"])
        require(code == "401", "gateway_socket_unexpected", code)
        return {"client_key": client, "ledger_account": entries[0]["id"], "link_port": record["link"],
                "gateway_port": record["gateway"]}

    def route(self, seat):
        """The private route, closed: both locations answer `relay_acceptance_pending` until acceptance."""
        paths, template = self.paths(seat), self.template()
        require(paths["ingress"].is_dir(), "gateway_not_installed")
        changed = self.nginx_apply(lambda text: insert_seat_block(text, template["seat"], seat))
        status, body = self.route_status(seat)
        opened = (paths["ingress"] / "catalog-ready").exists()
        require(status == (401 if opened else 503)
                and (opened or body.get("error", {}).get("code") == "relay_acceptance_pending"), "route_unexpected", status)
        return {"changed": changed, "closed": not opened}

    def open_gates(self, seat):
        """Let the one acceptance request through. Only the dedicated Sub2API account holds the key."""
        paths = self.paths(seat)
        require(paths["ingress"].is_dir() and not paths["ingress"].is_symlink(), "gateway_not_installed")
        for name in ("catalog-ready", "accepted"):
            gate = paths["ingress"] / name
            if not gate.exists():
                gate.write_text("console onboarding " + time.strftime("%Y%m%d") + "\n")
            gate.chmod(0o644)
        client = paths["client_key"].read_text().strip()
        status, _ = self.route_status(seat, key=client)
        require(status == 200, "route_unexpected", status)
        return {"open": True}

    def manager(self, seat, name, facts, sub_control_command, verify):
        """Publish the seat's console entry after one full status read succeeded with it."""
        paths, template = self.paths(seat), self.template()
        config = manager_config(template["manager"], seat, self.config["name_format"].format(name=name), facts, paths,
                                sub_control_command)
        paths["manager_state"].mkdir(mode=0o700, parents=True, exist_ok=True)
        state = verify(config)
        require(state["sub"].get("id") == facts["sub_account"] and state["runtime"].get("http_ready")
                and state["guard"]["ready"] and not state["authorization_latched"], "manager_status_not_ready",
                state["runtime"].get("failed_checks"))
        temporary = paths["manager_config"].with_name("." + paths["manager_config"].name)
        write_private(temporary, json.dumps(config, ensure_ascii=False))
        os.replace(temporary, paths["manager_config"])
        return {"relay_id": config["id"]}

    def mark_live(self, seat):
        paths = self.paths(seat)
        require(paths["manager_config"].exists(), "manager_not_installed")
        (paths["private"] / "live.marker").touch(mode=0o600)
        return {"live": True}

    def abandon(self, seat):
        """Remove everything this host holds for a seat that never went live."""
        paths, removed = self.paths(seat), []
        require(not (paths["private"] / "live.marker").exists(), "seat_is_live")
        if paths["manager_config"].exists():
            paths["manager_config"].unlink()
            removed.append("console-entry")
        if f"native-{seat}/" in self.nginx_text():
            self.nginx_apply(lambda text: remove_seat_block(text, seat))
            removed.append("route")
        units = [name for name in (paths["socket"], paths["proxy"], paths["link"]) if (SYSTEMD / name).exists()]
        for name in units:
            subprocess.run(["systemctl", "disable", "--now", name], capture_output=True, timeout=120)
            (SYSTEMD / name).unlink()
            removed.append(name)
        if units:
            run(["systemctl", "daemon-reload"])
        if paths["container"] in run(["docker", "ps", "-a", "--format", "{{.Names}}"]).split():
            run(["docker", "rm", "-f", paths["container"]], 90)
            removed.append(paths["container"])
        if paths["ingress"].is_dir() and not paths["ingress"].is_symlink():
            for entry in paths["ingress"].iterdir():
                entry.unlink()
            paths["ingress"].rmdir()
            removed.append("ingress")
        stamp = time.strftime("%Y%m%d%H%M%S")
        for folder in (paths["private"], paths["manager_state"]):
            if folder.exists():
                folder.rename(folder.with_name(f"{seat}.abandoned-{stamp}"))
        return {"removed": removed}
