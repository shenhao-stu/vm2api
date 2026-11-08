# Codex input text validation

Three upstream 400 responses rejected single text fields of 15,986,847–15,991,800 characters; the upstream reported a maximum of 10,485,760. The gateway now checks converted Responses text fields before selecting an account or dispatching. It returns `input_string_too_long` with the offending field and records zero attempts. Input remains unchanged; no truncation, splitting, retry, or change to the upload limit.

The check counts Unicode code points, avoiding false rejection of UTF-16 surrogate pairs. This affects Codex only, including converted Chat/Anthropic requests. Image payloads and function outputs retain their existing handling.

Validation: 167 affected tests on macOS, 584 production-image Linux tests with networking disabled. A fresh synthetic oversized input against the deployed controller returned HTTP 400, attempt_count=0, no VM, zero tokens and zero cost. Existing paid requests were not replayed.

Deployment replaced only two Codex protocol files over the current image. Four fixed egress addresses, concurrency10, account state, hourly quality probes and recovery history were preserved. Claude gateway and the two ReClaude relays were not restarted. The native maintenance endpoint's drained flag uses the Claude scheduler; operators must additionally wait for every Codex VM's reported inflight count to reach zero before restarting this controller.

A/B/05 source subscriptions were refreshed. Existing node configurations matched the refreshed subscription by configuration identity, independent of supplier line labels; no proxy restart or IP rearm was needed. Other historical errors include intentional unsupported-model/client rejection and caller cancellation during long xhigh reasoning; they are not proven to share this text-size root cause.
