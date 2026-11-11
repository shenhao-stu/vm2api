# IPEqual subscription mirrors

For HTTPS `/use/unsafe/sub.php` URLs on `equaldcdn.com` or `ipequal.com`,
subscription downloads prefer `equaldcdn.com` and retry `ipequal.com` once.
The path and signed query are preserved. Other providers, ports and paths do
not inherit these credentials or this mirror policy.

The two attempts share the existing 20-second download budget. Network/DNS
failure and invalid subscription content can trigger the alternate. Private
addresses, TLS downgrades and oversize content remain blocked. Both sources
failing leaves the last valid subscription and proxy bindings in place.

Successful refreshes continue to reconcile by node configuration hash, not
supplier line number. Supplier labels may change without changing a node.
Bound retired nodes, manual disables, account isolation and exit-IP guard
revisions are not relaxed by a mirror refresh. A new node never authorizes a
new egress IP or clears a guard latch.

The subscription panel's ordinary import/refresh routes use this behavior;
no separate polling service is introduced. Text snapshots stay local and do
not become remote subscriptions. The gateway must load the updated modules
before automatic fallback is active; merely changing the stored URL does
not enable fallback in a previously running process.
