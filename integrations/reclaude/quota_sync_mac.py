"""Sync only allowlisted numbers through the existing local Chrome and SSH transports."""
from contextlib import contextmanager
import json
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
def billing_tab(bridge, profile):
    def call(seq, name, **args):
        reply = rpc(bridge, seq, "tools/call", {"name": "browser_" + name, "arguments": args})
        if reply.get("isError"):
            raise RuntimeError("browser_" + name + "_failed")
        return json.loads(reply["content"][0]["text"])
    profiles = call(2, "profiles")["profiles"]
    if not any(p["id"] == profile and p["connected"] and not p["paused"] for p in profiles):
        raise RuntimeError("billing_profile_offline")
    tab = call(3, "open", profileId=profile, url=APP, reuse="exact")
    try:
        if tab["expectedUrl"] != APP:
            raise RuntimeError("billing_login_required")
        yield lambda expression: call(4, "evaluate", profileId=profile, tabId=tab["id"],
                                      expectedUrl=APP, expression=expression)["value"]
    finally:
        call(5, "release", profileId=profile, tabId=tab["id"], closeCreated=tab.get("created", False))


def sync(config):
    ids = {k: config[k] for k in ("org_id", "account_id", "binding")}
    if any(type(v) is not int or v <= 0 for v in ids.values()):
        raise ValueError("invalid_binding_config")
    script = """(async () => {
      const expected = IDS;
      const opts = {credentials:'same-origin', cache:'no-store', redirect:'error'};
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
    with subprocess.Popen([sys.executable, str(Path.home()/".tmwd/runtime/bridge.py"), "mcp"],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as bridge:
        try:
            rpc(bridge, 1, "initialize", {"protocolVersion": "2025-06-18",
                                         "clientInfo": {"name": "ReClaude billing reader", "version": "1"}, "capabilities": {}})
            with billing_tab(bridge, config["profile"]) as read:
                observation = read(script)
        finally:
            bridge.stdin.close()
    if not isinstance(observation, dict) or "error" in observation:
        raise ValueError("official_billing_unavailable")
    if set(observation) != {*ids, "used_usd", "quota_usd", "resets_at_ms", "observed_at_ms"}:
        raise ValueError("unexpected_billing_schema")
    subprocess.run(config["publish_command"], input=json.dumps(observation), text=True,
                   check=True, timeout=30, stdout=subprocess.DEVNULL)
    print("official_quota_updated", int(time.time()))


if __name__ == "__main__":
    sync(json.loads(Path(sys.argv[1]).read_text()))
