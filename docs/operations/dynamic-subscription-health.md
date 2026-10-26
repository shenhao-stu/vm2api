# Dynamic subscription maintenance

`scripts/subscription-health.py` is an optional host patrol around the native
panel API. It can be added without replacing or restarting the gateway. It does
not call a model or rotate credentials, proxies, account bindings or exit locks.

Configure only explicitly approved **dynamic** slots. On each run it checks that
the account, proxy, subscription node and guard revision still match, and that
`required` is false with no expected IP or latch. A fixed policy is never probed,
paused or resumed by this patrol. Do not configure a fixed slot here.

Normal operation uses one small HTTPS IP response every five minutes (288 per
day); only a failed first endpoint or a recovery uses a second endpoint. The
requests use authenticated SOCKS with remote DNS, certificate validation, no
redirects, no retries and no direct fallback. Each response body is capped at 2 KiB and each request at 12 seconds; TLS and
transport overhead are additional.
A successful response contains a public IP; dynamic IP changes are observations,
not changes to any pinned policy.

Two failed endpoints pause new requests for that slot using the native scheduling
toggle. Existing flows are not killed. A TLS/certificate or invalid-response
incident requires manual intervention. A single probe provider outage is not
enough to pause a working route.

The native subscription refresh runs at most every six hours when healthy and
only after observing all slots idle, because the current native refresh hot-loads
the shared Mihomo configuration. DNS is resolved again by the native importer.
In-flight observations are not a transactional drain, so this is low disturbance,
not a guarantee of zero effect. No VM or gateway restart is performed.

An outage allows up to three refresh/recheck recovery attempts, with 5/15/60-minute
backoff. Both HTTPS endpoints must then succeed. Recovery can clear only this
patrol's exact hold for the same account and dynamic policy. Quota, known revoked
credentials, an operator hold, a stopped VM, retained/removed subscription nodes,
new credentials or a fixed exit policy cannot be automatically cleared. A changed
node is not selected by name. Repeated failure stays paused for manual attention.
If refresh fails while the old route still works, the route remains usable and the
refresh warning is retained; the patrol does not discard a working configuration.

State is persistent, written before mutations, and protected by an exclusive
process lock. Notification reuses the native configured notifier (including
Feishu); it sends on state/issue transitions, not unchanged healthy ticks. State
and systemd journal also retain results. API errors are not proof of a node outage.

## Installation

Use a root-owned 0600 config with absolute paths, for example:

```json
{
  "project_root": "/opt/vm2api",
  "container": "vm2api",
  "panel_url": "http://127.0.0.1:18787",
  "state_dir": "/opt/vm2api/data/subscription-health",
  "targets": [{"vm_id": "approved-dynamic-slot", "proxy_id": "px-ID", "profile_id": "sub-ID"}]
}
```

Install the script outside the container and run it from a systemd oneshot timer
every five minutes. The script reads the existing gateway admin key from Docker
metadata in memory; no key is stored in this config or passed as an argument.
Restrict the service's writable paths to its state directory and cap time/memory.

Run `python3 -m unittest discover -s test/ops -v` before installation. First verify
the native API view and HTTPS check without calling `tick`. After enabling, verify
state, native subscription updated time, unchanged static guard revisions and
container start times, plus a successful notification receipt.

To retire it, stop and disable its timer. Before manually changing a managed
slot, stop the timer and wait for an active oneshot to finish: the native API has
separate reads and writes, not a compare-and-swap operation. The last-moment
ownership check reduces the race window but cannot make those operations atomic.
Do not delete state to bypass an incident.
For a manual incident review, inspect `state.json`, native slot/guard state and the
subscription. Fix the cause; explicitly decide whether to resume the slot through
the panel. For another managed recovery attempt, back up state and clear only the
reviewed target's `manual`, `recovery_attempts`, `next_attempt` and `next_refresh`
fields, retaining its identity and hold ownership. A credential or policy change
requires a new reviewed target baseline; never overwrite a fixed exit lock.
