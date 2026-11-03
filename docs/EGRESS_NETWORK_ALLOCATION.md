# Egress bridge allocation fallback

Docker's default address pool is finite. Repeating a slot start or recovery does
not free that pool. The egress network ensure path now keeps Docker's normal
allocation first, then handles only the two recognized IPv4 default-pool
exhaustion errors with an explicit-subnet fallback.

## Behavior and limits

- Inventory every current Docker network's IPAM subnets, IPv4 routes from **all**
  host route tables, and IPv4 interface prefixes. Missing tools, malformed output
  or incomplete inventory refuse the fallback; they do not allow a guessed subnet.
- Select a non-overlapping `/24` in `10.203.0.0/16`, with its `.1` gateway. A
  network-name hash spreads initial candidates. The range is a bounded candidate
  reserve, not a guarantee that it is unused on a particular host.
- On Docker's overlap-race error only, refresh the entire inventory and retry,
  up to four explicit create attempts. Other errors return immediately. A fully
  occupied reserve reports a refusal; operators must choose a new allocation
  strategy rather than prune production networks.
- Preserve the existing bridge name, IPv6-disabled and ICC-disabled options.
  Remote-proxy bridges retain masquerade disabled; local-route bridges retain
  masquerade enabled. Existing networks are returned unchanged on later ensures only after their ownership labels pass the instance/resource check.
- This does not delete networks, change Docker default pools, restart Docker,
  bypass proxy isolation, rebind a slot, clear proxy cooldowns or schedule a new
  background repair loop. Existing manual/automatic start and recovery callers
  gain the fallback when they reach network creation; stopped slots are not
  started merely by installing this code.

The `ip` commands must inspect the **same host network namespace** as the Docker
engine creating the bridge. The supplied host-network control-plane deployment
provides that relationship and installs `iproute2`. When
`KIN_EGRESS_CMD_PREFIX` is set, IP inventory uses the same host namespace adapter
as `ss` and `iptables`. The supplied `scripts/docker-host-net.sh` accepts only
`ip -j -4 route show table all` and `ip -j -4 address show` for this purpose; a
missing or incompatible adapter refuses fallback. A bridged control plane or a
remote Docker daemon needs an appropriate host-side inventory adapter first;
container-only routes are not a valid host inventory. The check is a point-in-time
snapshot, not coordination with future host/VPN route changes.

For named instances, both the ordinary and explicit-subnet create paths carry
`vm2api.instance` and `vm2api.resource` labels. Existing unlabelled resources,
resources owned by another instance (including c2a), and wrong resource IDs are
rejected without create/remove operations. Empty route inventories or inventories
without IPv4 interface prefixes also refuse explicit allocation.

## Focused fixtures

`test/unit/egress-network.test.mjs` defines deterministic, mocked cases for normal
allocation, unrelated errors, both exhaustion messages, collision avoidance,
invalid inventories, bounded overlap races, local/remote isolation options and
persistent reuse. It never invokes a real Docker daemon or changes host routes.

Run the deterministic allocation fixtures locally:

```sh
node --test test/unit/egress-network.test.mjs
```

For Linux packaged-runtime validation, point `KIN_EGRESS_BIN` at the source-built
helper and run `test/unit/egress.test.mjs` alongside these fixtures. The process
fixtures launch temporary local helpers; Docker inventory and create operations
in allocation fixtures remain injected mocks. This check does not require pruning
or modifying existing Docker networks. Inference acceptance needs its separate
real-account test after credentials are imported.
