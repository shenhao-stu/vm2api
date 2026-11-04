# Native Relay rate-limit errors

A native CLI can emit a rejected `rate_limit_event` before an API-error assistant
message. The adapter retains the structured reset for the requested model rather
than classifying this as an incomplete transport stream.

For an already dispatched request, HTTP status remains **400**, and the error
code/message remain `native_request_consumed_no_replay`. Optional `error.details`:

```json
{
  "upstream_type": "rate_limit_error",
  "model": "claude-sonnet-5-5",
  "rate_limit_type": "seven_day",
  "reset_at": 1793815200,
  "no_replay": true
}
```

`reset_at` is a Unix timestamp in seconds copied from native `resetsAt`, not a
parsed guess from a localized message. Invalid or missing values are omitted.
No token count, charge or successful completion is inferred from this error.
The consumed request remains consumed. If the native rejection occurs before
any dispatch, it can return 429 without claiming a consumed request.

The optional API passthrough mode preserves only the known native no-replay and
rate-limit codes, their constant messages, and validated quota fields above.
It never copies arbitrary upstream error objects, URLs, debug data or nested
extras. Other errors and default gateway normalization remain unchanged. A downstream
scheduler may use a fresh, validated reset to cool the **specified model** on
that account; it must not replay the rejected request, clear an exit guard, or
pause unrelated model windows. In particular, a Sonnet weekly limit is not
evidence that the Fable window is exhausted.

Regression coverage uses local CLI fixtures and HTTP servers only. Native
HTTP/SSE failures remain single-dispatch, repeat requests remain blocked,
other independent sessions/models remain available, and ordinary API errors
keep their existing normalized shape. Deployment requires coordinated updates
to the native adapter and the isolated API gateway; source tests alone do not
prove the production bridge or downstream SSE error mapping has been updated.
