# Adding a native Relay seat from the console

An administrator picks an exit, names the seat, enters its organization number and
presses **开始授权**. The console shows one authorization link. After the administrator
approves it in a browser, the seat is built, checked with two real requests and joins the
shared pool by itself. Nothing else waits for input.

This is optional. Without `--onboarding`, the management server answers 404 on the
onboarding route and the console hides the entry.

## How a seat is built

Every seat is a copy of one healthy **template seat** on three hosts, with only its identity
replaced. Each copy is compared with the template before it is used.

| Host | Code | What it creates for a seat |
| --- | --- | --- |
| Container host | `onboarding_nas_agent.py` | network, firewall chain, exit connector, native container, HTTP worker, management agent |
| Gateway host | `onboarding_runner.py`, `onboarding_happy.py` | tunnel, gateway container, private nginx route, console entry |
| Account host | `onboarding_sub_broker.py` | dedicated Sub2API account, acceptance group, public 404 rule, shared routing |

The runner executes fixed steps in order. Each step ends in a verified state and is safe to
run again:

`preflight → prepare → exit_check → login → native → worker → native_canary → gateway →
route → sub → sub_canary → manager → promote → live`

- The exit must still show the address the administrator saw when choosing it. A changed
  address stops the session; it is never accepted automatically.
- `login` starts the device login once and waits up to 15 minutes. Short gaps in reaching
  the container host, and a runner restart, do not end the wait or start a second login.
- A model is called twice per seat: once at the worker, once end to end through Sub2API.
  Neither is repeated automatically (three attempts at most, each started by an administrator).
- The account joins the shared groups only after the end-to-end request was billed to it.
- One session runs at a time.

A failed step leaves the session where it stopped. The console offers **重试这一步** when the
failure can go away by itself, and always **放弃并清理**, which removes what was created on
the account host, the gateway host and the container host, in that order. A live seat is
never removed by abandon. `prepare` and `login` are not retried: abandon and start again.

## Trust boundary

The management server stays sandboxed and unprivileged in effect: it reads session files
and writes small request files into a spool. A separate root service, the runner, takes
requests from the spool and validates them again. The browser can send only a display
name, an exit id from the administrator's list, an organization number and operation ids.
None of them becomes a path, a command or a host.

Finished seats are published as files in `manager-configs/`. The management server picks
them up within a few seconds, so adding or abandoning a seat never restarts it.

## Install

Keep every file below outside the repository, owner-only (`0700` directories, `0600` files).

**Container host.** Copy `onboarding_nas_agent.py` and a `config.json` into one private
directory. The existing control SSH command of the template seat runs
`python3 -B AGENT CONFIG`. Check it with `{"action": "selfcheck"}` on stdin.

| Key | Meaning |
| --- | --- |
| `vm_root`, `home` | directory that holds the seats; directory of this agent |
| `template` | names, numbers and ports of the template seat |
| `allocation` | first values of the ranges new seats take their subnet and ports from |
| `probe_url`, `exit_probes`, `login_hosts` | exit check services; hosts the login may reach |
| `native_cli`, `canary_model`, `concurrency`, `min_free_mb` | runtime settings and the memory floor |
| `direct_label` | label of the template's own exit |

More exits come from `egress-options.json` beside the agent:
`{"<id>": {"label": …, "expected_ip": …, "proxy_url": …}}`. Add an exit only after
checking its address yourself; the console lists what this file and the template provide.

**Account host.** Copy `onboarding_sub_broker.py`, `management_sub.py` and a `config.json`
into one private directory. Generate two SSH keys **on the gateway host** and add only their
public halves to `authorized_keys`, each limited to the gateway host's address:

    from="GATEWAY",restrict,command="python3 -B BROKER CONFIG onboarding" ssh-ed25519 …
    from="GATEWAY",restrict,command="python3 -B BROKER CONFIG control" ssh-ed25519 …

| Key | Meaning |
| --- | --- |
| `root` | private directory for seat records and receipts |
| `native_api_path`, `control_broker` | local Sub2API admin helper; path of `management_sub.py` |
| `reference_account`, `routing_groups`, `relay_accounts` | account to clone; groups whose model routing lists relays; existing relay accounts |
| `base_url_prefix`, `public_origin`, `public_path_prefix` | private route as Sub2API reaches it; public name that must answer 404 |
| `account_name`, `canary_model`, `release_lock` | name pattern (`{name}`, `{seat}`); acceptance model; lock shared with releases |
| `sub` | `container`, `url`, `admin_user` |
| `caddy` | `admin`, `host`, `site`, `matcher`, `marker_path`, `environment`, `binary`, `config` |

**Gateway host.** Put `management_server.py`, `management.py`, `enrolled_device.py`,
`onboarding_store.py`, `onboarding_runner.py` and `onboarding_happy.py` into `ROOT/code`,
the keys into `ROOT/keys`, and write `ROOT/runner.json`:

| Key | Meaning |
| --- | --- |
| `root` | `ROOT` |
| `nas_command` | argv that runs the container-host agent |
| `sub_command`, `sub_control_command` | argv for the two account-host keys |
| `login_wait_seconds` | optional, default 900 |
| `happy` | `template_seat`, `template_manager`, `ingress_root`, `nginx_conf`, `nginx_lock`, `private_listener`, `port_first`, `port_count`, `min_free_kb`, `name_format` |

Run the runner as a root service, `python3 -B ROOT/code/onboarding_runner.py ROOT/runner.json`,
with `Restart=on-failure`. Create `ROOT/spool` and `ROOT/manager-state` **before** restarting
the management service, then start it from `ROOT/code` with `--onboarding ROOT` and let its
sandbox write only those two directories:

    ReadWritePaths=-ROOT/spool -ROOT/manager-state

To remove the feature, drop that systemd override and restart the management service. Seats
that are already live keep serving; re-add their `manager-configs/*.json` as `--config`
arguments to keep them in the console.

## Limits

- Official quota windows and seat quota are not attached to onboarded seats automatically.
- Abandoning a seat whose device was already approved removes the local seat; the device
  stays registered with the provider until it is removed there.
- An exit that is not in the administrator's list cannot be chosen from the console.
