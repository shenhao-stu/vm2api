# Cluster slot file transfers

Slot start copies the native worker and egress binaries over the node's existing, host-key-pinned SSH connection. A slow start is not evidence that model inference itself is slow.

`writeRemoteFile` keeps 32 KiB requests and allows at most eight writes per file at once. Writes use explicit offsets into an exclusively created temporary file; permissions and ownership are applied before atomic replacement. A failed write never publishes the partial file. Channel close/error and a 30-second operation deadline terminate stalled uploads. Cleanup has a bounded deadline. There is no automatic retry of an uncertain write or a model request.

Before a maintenance restart:

1. Record actual container/image, runtime source overlays, slot identity/policies, keys, proxy pins, guard state and upstream scheduling state. Preserve credentials and usage records in place.
2. Pause only affected upstream accounts and use native schedule hold to drain requests. Abort if drain is not confirmed.
3. Back up the changed source and apply only the reviewed files. Recreating a stale image can discard unrelated runtime fixes.
4. After restart, confirm each originally healthy proxy still has its original expected IP using two independent HTTPS sources. Rearm only with explicit operator authorization for this maintenance. Do not clear a pre-existing fault or accept a new IP.
5. Check actual slot containers and native `/vms/:id/diagnose`, including remote link, egress relay and kernel. A configuration reload may leave a slot stopped. Start stopped slots through the native endpoint; avoid restarting already healthy slots or repeating a start with an unknown result.
6. Resume each affected upstream account only after its slot passes diagnosis. Preserve account/key affinity, model allowlists and concurrency.
7. Reconcile any explicitly authorized new acceptance request with final usage records. Never replay an already consumed or uncertain request.

If SSH disconnects during upload, inspect the original request outcome and remote writers before retrying startup. Remove only an identified orphan temporary file after verifying no process has it open. Do not reset slot HOME, OAuth, device identity or the database to resolve an upload failure.

Regression coverage includes bounded parallelism, out-of-order offsets, permissions, atomic publication, channel loss, silent callbacks, bounded cleanup, shared channel listeners and late callbacks. On Linux, root ownership tests need temporary CHOWN/FOWNER/DAC_OVERRIDE capabilities in the isolated test container; those capabilities are not required for production slot guests.

An initial four-transfer, 256 KiB ABBA sample reduced mean upload time from 6.04 to 4.04 seconds. This small transport sample is not a model first-token benchmark or a guarantee for other networks.
