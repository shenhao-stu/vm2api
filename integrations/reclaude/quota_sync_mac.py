"""Sync only allowlisted numbers through the existing local Chrome and SSH transports."""
from contextlib import contextmanager
import json
import re
from pathlib import Path
import subprocess
import sys
import time

APP = "https://www.reclaude.ai/app"


def rpc(bridge, number, method, params):
    request = {"jsonrpc": "2.0", "id": number, "method": method, "params": params}
    bridge.stdin.write(json.dumps(request) + "\n")
    bridge.stdin.flush()
    response = json.loads(bridge.stdout.readline())
    if response.get("id") != number or "error" in response:
        raise RuntimeError("browser_bridge_error")
    return response["result"]


@contextmanager
def billing_tab(bridge, profile, app=APP):
    if app not in (APP, "https://www.recode.cat/app"):
        raise ValueError("invalid_billing_origin")
    def call(seq, name, **args):
        reply = rpc(bridge, seq, "tools/call", {"name": "browser_" + name, "arguments": args})
        if reply.get("isError"):
            details = json.loads(reply["content"][0]["text"])
            code = str(details.get("code", "UNKNOWN"))
            # Bridge descriptions may contain page content. Log only its short code.
            safe_code = code if re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", code) else "UNKNOWN"
            raise RuntimeError(f"browser_{name}_{safe_code}")
        return json.loads(reply["content"][0]["text"])
    profiles = call(2, "profiles")["profiles"]
    if not any(p["id"] == profile and p["connected"] and not p["paused"] for p in profiles):
        raise RuntimeError("billing_profile_offline")
    tab = call(3, "open", profileId=profile, url=app, reuse="exact")
    try:
        if tab["expectedUrl"] != app:
            raise RuntimeError("billing_login_required")
        yield lambda expression: call(4, "evaluate", profileId=profile, tabId=tab["id"],
                                      expectedUrl=app, expression=expression, timeoutMs=30000)["value"]
    finally:
        call(5, "release", profileId=profile, tabId=tab["id"], closeCreated=tab.get("created", False))


ACCOUNT_WINDOWS = """(async () => {
    const ids = IDS;
    const options = { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(18000) };
    const [orgs, devices] = await Promise.all(['/api/app/orgs/', '/api/app/devices?org_id=' + ids.org_id].map(async path => {
        const response = await fetch(path, options);
        return response.ok ? response.json() : null;
    }));
    const account = orgs?.items?.find(org => org.id === ids.org_id)?.current_account;
    if (account?.id !== ids.account_id || !Array.isArray(devices) || !devices.some(d => d.org_id === ids.org_id && d.id === ids.binding && d.revoked_at === null)) return null;
    const windows = {};
    for (const key of ['five_hour', 'seven_day']) {
        const w = account.usage_snapshot?.[key];
        if (!w || !Number.isFinite(w.utilization) || w.utilization < 0 || !Number.isFinite(Date.parse(w.resets_at))) return null;
        windows[key] = {used_percent:w.utilization, resets_at:w.resets_at};
    }
    return {ok:true, org:ids.org_id, account_id:ids.account_id, binding:ids.binding, source_updated:account.usage_updated_at, observed_at_ms:Date.now(), windows};
})()"""


def sync(config):
    ids = {k: config[k] for k in ("org_id", "account_id", "binding")}
    if any(type(v) is not int or v <= 0 for v in ids.values()):
        raise ValueError("invalid_binding_config")
    script = """(async () => {
      const expected = IDS;
      const opts = {credentials:'same-origin', cache:'no-store', redirect:'error', signal:AbortSignal.timeout(20000)};
      const [qr, dr] = await Promise.all([
        fetch('/api/app/billing/carpool-quota?org_id=' + expected.org_id, opts),
        fetch('/api/app/devices?org_id=' + expected.org_id, opts)
      ]);
      if (!qr.ok || !dr.ok) return {error:'billing_access_denied'};
      const q = await qr.json(), devices = await dr.json();
      if (q.enabled !== true || q.account_id !== expected.account_id ||
          !Array.isArray(devices) || !devices.some(d => d.id === expected.binding &&
              d.org_id === expected.org_id && d.revoked_at === null))
        return {error:'billing_scope_unavailable'};
      for (const key of ['used_usd','quota_usd']) {
        if (!['string','number'].includes(typeof q[key]) || String(q[key]).trim() === '' ||
            !Number.isFinite(Number(q[key]))) return {error:'invalid_official_amount'};
      }
      return {...expected, used_usd:Number(q.used_usd), quota_usd:Number(q.quota_usd),
        resets_at_ms:q.resets_at_ms ?? null, observed_at_ms:Date.now()};
    })()""".replace("IDS", json.dumps(ids))
    kind = config.get("quota_kind", "carpool")
    fields = {*ids, "used_usd", "quota_usd", "resets_at_ms", "observed_at_ms"}
    if kind == "account_windows":
        script = ACCOUNT_WINDOWS.replace("IDS", json.dumps(ids))
        fields = {"ok", "org", "account_id", "binding", "source_updated", "observed_at_ms", "windows"}
    elif kind != "carpool":
        raise ValueError("invalid_quota_kind")
    with subprocess.Popen([sys.executable, str(Path.home()/".tmwd/runtime/bridge.py"), "mcp"],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as bridge:
        try:
            rpc(bridge, 1, "initialize", {"protocolVersion": "2025-06-18",
                                         "clientInfo": {"name": "ReClaude billing reader", "version": "1"}, "capabilities": {}})
            with billing_tab(bridge, config["profile"], config.get("app_url", APP)) as read:
                observation = read(script)
        finally:
            bridge.stdin.close()
    if not isinstance(observation, dict) or "error" in observation:
        raise ValueError("official_billing_unavailable")
    org_key = "org" if kind == "account_windows" else "org_id"
    if (set(observation) != fields or observation.get(org_key) != ids["org_id"]
            or observation.get("binding") != ids["binding"] or observation.get("account_id") != ids["account_id"]):
        raise ValueError("unexpected_billing_schema")
    subprocess.run(config["publish_command"], input=json.dumps(observation), text=True,
                   check=True, timeout=75, stdout=subprocess.DEVNULL)
    print("official_quota_updated", int(time.time()))


if __name__ == "__main__":
    sync(json.loads(Path(sys.argv[1]).read_text()))
