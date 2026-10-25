# Dynamic exit on one proxy

The fixed-IP guard defaults remain unchanged. An administrator may explicitly
opt one dynamic proxy out with `PUT /api/panel/proxy-exit-guard/:id` and the exact
body `{"required":false}`. This quiesces only that proxy's bound slots before
saving the policy. It does not start a slot, clear another proxy's latch, or
change its approved IP.

The slot still uses its native bound SOCKS transport and private network; an
unreachable proxy must fail instead of falling back to a direct connection.
Its public IP may change and is not an approved security baseline. Use a
dedicated proxy binding, separate account HOME and concurrency one as needed.
Do not confuse sharing account capacity with sharing users' conversation state.

Unconfigured proxies continue to inherit the global guard. Malformed overrides
fail closed. Disabling the global guard retains its existing global behavior;
do not use that operation to provision a single dynamic slot.

To return this proxy to fixed-IP mode, use its normal `PUT` operation with an
explicit `expected_ip`; this creates a fresh policy revision and requires a
successful probe. `POST .../rearm` cannot disable checking or accept a different
IP. As with other policy changes, verify the slot before explicitly starting it.

Do not route production traffic to a newly created slot until its owner has
completed OAuth and the account, stream, session isolation and billing checks
have passed. OAuth browser traffic uses the browser's network; it does not
inherit the server's proxy merely by opening the authorization page.
