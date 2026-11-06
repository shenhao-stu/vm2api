# Unified console release

Build from `web` with `npm run build:unified -- --base=/native-console/`.
The default `build` target intentionally supports a standalone controller only.
Before publishing the shared console, require `dist/controllers.json` to contain
`{"controllers":["main","codex"]}`. Publish immutable assets before atomically
replacing `index.html`; retain old assets and the previous index for rollback.

Verify in an authenticated browser, rather than treating an HTTP 200 as UI acceptance:

- Select Codex and confirm its OAuth slots, account details and import default.
- Navigate to logs with `kind=error`; retain both controller and filter.
- Switch to Claude/ReClaude and back; verify each controller's own slot list.
- Test a signed-out overview redirect: the document keeps `controller=codex`,
  while the hash redirect contains only the console route.

Static console releases require no gateway or account-container restart.
