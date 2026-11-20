"""Provision one native Relay seat on the container host by cloning a healthy template seat.

One JSON request on stdin, one JSON result on stdout:

    {"action": "prepare", "seat": "3fa91c0b", "egress": "direct", "expected_ip": "203.0.113.7"}
    {"ok": true, ...}  or  {"ok": false, "error": "<stable code>", "detail": "<short text>"}

The template seat, address ranges and login hosts come from a private configuration file.
Nothing in a request becomes a path, a command or a host: a seat is an eight-digit hex id,
and every name is derived from it. Containers, units and management files are copied from
the template with only its identity replaced, and a new container is then compared with the
template field by field.

`canary` is the only action that calls a model. It sends exactly one request per attempt.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

SYSTEMD = Path("/etc/systemd/system")
SEAT_ID = re.compile(r"[0-9a-f]{8}")
EGRESS_ID = re.compile(r"[a-z0-9][a-z0-9-]{1,31}")
SEAT_FOLDERS = ("home", "work", "guard", "egress", "evidence", "accounting", "management")
SEAT_ENVIRONMENT = ("HOME", "USER", "PATH", "LANG", "TZ")
MAX_CANARIES = 3
CONFIG = {}


class Refused(Exception):
    """A precondition or a verification failed. The code is shown to an administrator."""

    def __init__(self, code, detail=""):
        self.code, self.detail = code, str(detail)[:300]
        super().__init__(code)


def require(condition, code, detail=""):
    if not condition:
        raise Refused(code, detail)


def run(arguments, timeout=40, stdin=None):
    done = subprocess.run(arguments, capture_output=True, text=True, timeout=timeout, input=stdin)
    if done.returncode:
        raise Refused("command_failed", f"{Path(arguments[0]).name} {' '.join(arguments[1:3])}: {done.stderr.strip()[-160:]}")
    return done.stdout.strip()


def sudo(*arguments, timeout=40):
    return run(["sudo", "-n", *arguments], timeout)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


# ---------------------------------------------------------------- identity

def template():
    """Names and numbers of the seat every new seat is cloned from."""
    source = CONFIG["template"]
    return {**source, "root": Path(CONFIG["vm_root"]) / source["dir"]}


def seat_names(seat):
    require(isinstance(seat, str) and SEAT_ID.fullmatch(seat), "invalid_seat")
    return {
        "seat": seat,
        "dir": "reclaude-seat-" + seat,
        "root": Path(CONFIG["vm_root"]) / ("reclaude-seat-" + seat),
        "container": "reclaude-native-seat-" + seat,
        "bridge": "krs" + seat,
        "chain": "RS" + seat.upper(),
        "unit": "reclaude-native-http-seat-" + seat,
        "ingress": "reclaude-seat-" + seat + "-guest-ingress",
        "label": seat,
    }


def allocation_of(names):
    stored = read_json(names["root"] / "onboarding.json")
    require(isinstance(stored, dict), "seat_not_prepared")
    return stored


def identity_pairs(names, allocation, binding=None, org=None):
    """What to replace in template text. Numbers only match as whole numbers."""
    old = template()
    pairs = [
        (old["ingress"], names["ingress"]),
        (old["unit"], names["unit"]),
        (old["container"], names["container"]),
        (old["dir"], names["dir"]),
        (old["bridge"], names["bridge"]),
        (old["chain"], names["chain"]),
        ("AgentNAS-ReClaude-" + old["label"], "AgentNAS-ReClaude-" + names["label"]),
        ("Seat " + old["label"], "Seat " + names["label"]),
        (old["net"], "172.30.%d." % allocation["octet"]),
        (int(old["tcp"]), allocation["tcp"]),
        (int(old["dns"]), allocation["dns"]),
        (int(old["port"]), allocation["port"]),
    ]
    if binding is not None:
        pairs += [(int(old["binding"]), int(binding)), (int(old["org"]), int(org))]
    return pairs


def substitute(text, pairs):
    """Replace every old value in one pass, so a new value is never rewritten again."""
    patterns, replacement = [], {}
    for old, new in sorted(pairs, key=lambda pair: -len(str(pair[0]))):
        if isinstance(old, int):
            patterns.append(r"(?<![0-9])" + str(old) + r"(?![0-9])")
        else:
            patterns.append(re.escape(old))
        replacement[str(old)] = str(new)
    return re.sub("|".join(patterns), lambda match: replacement[match.group(0)], text)


def render(text, names, allocation, binding=None, org=None):
    result = substitute(text, identity_pairs(names, allocation, binding, org))
    old = template()
    left = [old[key] for key in ("container", "dir", "bridge", "chain", "net") if old[key] in result]
    require(not left, "template_identity_left", left)
    return result


# ---------------------------------------------------------------- firewall and exit

def firewall_rules(bridge, chain, subnet, tcp, dns):
    """The transparent-egress rules of one seat network, exactly as the template recorded them."""
    tcp, dns = str(tcp), str(dns)
    accept_tcp = ["-i", bridge, "-s", subnet, "-d", subnet, "-p", "tcp", "-m", "multiport", "--dports", tcp + "," + dns, "-j", "ACCEPT"]
    accept_udp = ["-i", bridge, "-s", subnet, "-d", subnet, "-p", "udp", "--dport", dns, "-j", "ACCEPT"]
    drop_leaving = ["-i", bridge, "!", "-d", subnet, "-j", "DROP"]
    drop_input = ["-i", bridge, "-j", "DROP"]
    drop_new_inbound = ["-o", bridge, "!", "-i", bridge, "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP"]
    add = [
        ["-t", "nat", "-N", chain],
        ["-t", "nat", "-A", "PREROUTING", "-i", bridge, "-j", chain],
        ["-t", "nat", "-F", chain],
        ["-t", "nat", "-A", chain, "-d", subnet, "-j", "RETURN"],
        ["-t", "nat", "-A", chain, "-p", "tcp", "--dport", "53", "-j", "REDIRECT", "--to-ports", dns],
        ["-t", "nat", "-A", chain, "-p", "udp", "--dport", "53", "-j", "REDIRECT", "--to-ports", dns],
        ["-t", "nat", "-A", chain, "-p", "tcp", "-j", "REDIRECT", "--to-ports", tcp],
        ["-t", "filter", "-I", "INPUT", "1", *accept_tcp],
        ["-t", "filter", "-I", "INPUT", "1", *accept_udp],
        ["-t", "filter", "-I", "FORWARD", "1", *drop_leaving],
    ]
    extra = [
        ["-t", "filter", "-I", "INPUT", "1", *drop_input],
        ["-t", "filter", "-I", "FORWARD", "1", *drop_new_inbound],
    ]
    delete = [
        ["-t", "nat", "-D", "PREROUTING", "-i", bridge, "-j", chain],
        ["-t", "nat", "-F", chain],
        ["-t", "nat", "-X", chain],
        ["-t", "filter", "-D", "FORWARD", *drop_leaving],
        ["-t", "filter", "-D", "INPUT", *accept_tcp],
        ["-t", "filter", "-D", "INPUT", *accept_udp],
    ]
    delete_extra = [
        ["-t", "filter", "-D", "INPUT", *drop_input],
        ["-t", "filter", "-D", "FORWARD", *drop_new_inbound],
    ]
    return {"add": add, "extra": extra, "delete": delete, "delete_extra": delete_extra}


def template_firewall_matches():
    """The generator must reproduce what was recorded when the template was built by hand."""
    old = template()
    recorded = read_json(old["root"] / "evidence/firewall.json")
    if not isinstance(recorded, dict):
        return False
    mine = firewall_rules(old["bridge"], old["chain"], old["net"] + "0/24", old["tcp"], old["dns"])
    their_add = [rule for rule in recorded["plan"]["add"] if "-C" not in rule]
    return mine["add"] == their_add and mine["extra"] == recorded["extra"] and mine["delete"] == recorded["plan"]["del"]


def guard_state(root):
    return read_json(Path(root) / "guard/exit-guard-state.json", {})


def guard_ok(root, expected_ip):
    state = guard_state(root)
    return (state.get("ready") is True and state.get("latched") is False
            and state.get("expected_ip") == state.get("observed_ip") == expected_ip)


def egress_options():
    """Exits an administrator has verified. `direct` reuses the template's own connector."""
    old = read_json(template()["root"] / "egress/config.json")
    options = {"direct": {"label": CONFIG.get("direct_label", "Direct"),
                          "expected_ip": old["exit_guard"]["expected_ip"], "proxy_url": old["proxy_url"]}}
    for key, value in (read_json(Path(CONFIG["home"]) / "egress-options.json") or {}).items():
        require(EGRESS_ID.fullmatch(key) and key != "direct", "invalid_egress_option", key)
        options[key] = {field: value[field] for field in ("label", "expected_ip", "proxy_url")}
    return options


def observed_exit(proxy_url):
    probe = subprocess.run(
        ["curl", "-q", "--noproxy", "", "--max-time", "20", "-fsS", "--config", "-", CONFIG["probe_url"]],
        input="proxy = " + json.dumps(proxy_url) + "\n", text=True, capture_output=True, timeout=25)
    return probe.stdout.strip() if probe.returncode == 0 else None


# ---------------------------------------------------------------- allocation

def listening_ports():
    return {int(port) for port in re.findall(r":(\d+)\s", run(["ss", "-Hlntu"]))}


def allocate():
    """A free /24, egress port pair and worker port. Nothing is reused from another seat."""
    ranges = CONFIG["allocation"]
    subnets = run(["bash", "-c", "docker network inspect $(docker network ls -q) "
                                 "--format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'"])
    used = {int(octet) for octet in re.findall(r"172\.30\.(\d+)\.0/24", subnets)}
    for path in Path(CONFIG["vm_root"]).glob("reclaude-seat-*/onboarding.json"):
        # An abandoned seat keeps its directory under another name; its numbers are free again.
        if SEAT_ID.fullmatch(path.parent.name.removeprefix("reclaude-seat-")):
            used.add((read_json(path) or {}).get("octet"))
    busy = listening_ports()
    for index, octet in enumerate(range(ranges["octet_first"], ranges["octet_last"] + 1)):
        candidate = {"octet": octet, "dns": ranges["dns_first"] + 100 * index,
                     "tcp": ranges["tcp_first"] + 100 * index, "port": ranges["port_first"] + index}
        if octet not in used and not busy & {candidate["dns"], candidate["tcp"], candidate["port"]}:
            return candidate
    raise Refused("no_free_allocation")


# ---------------------------------------------------------------- containers

def inspect(name):
    return json.loads(run(["docker", "inspect", name]))[0]


def existing(kind):
    command = {"container": ["docker", "ps", "-a", "--format", "{{.Names}}"],
               "running": ["docker", "ps", "--format", "{{.Names}}"],
               "network": ["docker", "network", "ls", "--format", "{{.Name}}"]}[kind]
    return run(command).split()


def container_shape(inspection):
    """The settings a clone must share with its template."""
    host, config = inspection["HostConfig"], inspection["Config"]
    networks = inspection["NetworkSettings"]["Networks"]
    return {
        "image": inspection["Image"], "entrypoint": config.get("Entrypoint"), "command": config.get("Cmd"),
        "user": config.get("User"), "workdir": config.get("WorkingDir"), "labels": config.get("Labels"),
        "hostname": config.get("Hostname") if host["NetworkMode"] != "host" else None,
        "environment": sorted(config.get("Env") or []),
        "mounts": sorted([m["Type"], m["Source"], m["Destination"], m["RW"]] for m in inspection["Mounts"]),
        "network": host["NetworkMode"], "restart": host["RestartPolicy"]["Name"],
        "read_only": host.get("ReadonlyRootfs"), "cap_drop": host.get("CapDrop"), "cap_add": host.get("CapAdd"),
        "security": host.get("SecurityOpt"), "pids": host.get("PidsLimit"), "memory": host.get("Memory"),
        "swap": host.get("MemorySwap"), "cpus": host.get("NanoCpus"), "log": host.get("LogConfig"),
        "sysctls": host.get("Sysctls"), "tmpfs": host.get("Tmpfs"),
        "addresses": sorted((value.get("IPAMConfig") or {}).get("IPv4Address") or "" for value in networks.values()),
    }


def docker_arguments(inspection, names, allocation, kind):
    """`docker run` arguments that rebuild the template container under the new identity."""
    host, config = inspection["HostConfig"], inspection["Config"]
    old = template()
    arguments = ["--label", "owner=" + names["container"], "--restart", host["RestartPolicy"]["Name"] or "no",
                 "--user", config["User"]]
    if host.get("ReadonlyRootfs"):
        arguments.append("--read-only")
    for capability in host.get("CapDrop") or []:
        arguments += ["--cap-drop", capability]
    for option in host.get("SecurityOpt") or []:
        arguments += ["--security-opt", option]
    arguments += ["--pids-limit", str(host["PidsLimit"]), "--memory", str(host["Memory"]),
                  "--memory-swap", str(host["MemorySwap"]), "--cpus", str(host["NanoCpus"] / 1e9)]
    for key, value in (host["LogConfig"].get("Config") or {}).items():
        arguments += ["--log-opt", f"{key}={value}"]
    for key, value in (host.get("Sysctls") or {}).items():
        arguments += ["--sysctl", f"{key}={value}"]
    for key, value in (host.get("Tmpfs") or {}).items():
        arguments += ["--tmpfs", f"{key}:{value}"]
    for mount in inspection["Mounts"]:
        require(mount["Type"] == "bind", "template_mount_unsupported", mount["Type"])
        source = mount["Source"].replace(str(old["root"]), str(names["root"]))
        arguments += ["--mount", f"type=bind,src={source},dst={mount['Destination']}" + ("" if mount["RW"] else ",readonly")]
    if kind == "egress":
        require(host["NetworkMode"] == "host", "template_egress_network_changed")
        arguments += ["--network", "host"]
    else:
        for entry in config.get("Env") or []:
            if entry.split("=")[0] in SEAT_ENVIRONMENT:
                arguments += ["--env", entry]
        arguments += ["--network", names["container"] + "-net", "--ip", "172.30.%d.10" % allocation["octet"],
                      "--hostname", "AgentNAS-ReClaude-" + names["label"], "--workdir", config["WorkingDir"]]
    entrypoint = config.get("Entrypoint") or []
    require(len(entrypoint) == 1, "template_entrypoint_unsupported")
    return arguments + ["--entrypoint", entrypoint[0], inspection["Image"], *(config.get("Cmd") or [])]


def create_like_template(names, allocation, kind):
    """Start a container cloned from the template and prove it has the template's shape."""
    suffix = "-egress" if kind == "egress" else ""
    source = inspect(template()["container"] + suffix)
    name = names["container"] + suffix
    run(["docker", "run", "-d", "--name", name, *docker_arguments(source, names, allocation, kind)], 90)
    wanted = json.loads(render(json.dumps(container_shape(source)), names, allocation))
    actual = container_shape(inspect(name))
    different = sorted(key for key in wanted if wanted[key] != actual[key])
    require(not different, "container_shape_mismatch", different)


# ---------------------------------------------------------------- read-only actions

def login_urls(text):
    """Authorization links printed by the native login command."""
    found = []
    for link in re.findall(r"https://[^\s\x1b\"<>]+", text):
        host, _, rest = link[len("https://"):].partition("/")
        if host in CONFIG["login_hosts"] and "?" in rest and any(part in rest for part in ("cli/", "device/", "authorize", "login")):
            found.append(link)
    return found


def act_options(request):
    return {"options": [{"id": key, "label": value["label"], "expected_ip": value["expected_ip"]}
                        for key, value in egress_options().items()]}


def act_selfcheck(request):
    """Everything a clone depends on, checked against the live template without changing anything."""
    old = template()
    seat, egress = inspect(old["container"]), inspect(old["container"] + "-egress")
    sample, numbers = seat_names("0" * 8), {"octet": 250, "tcp": 1, "dns": 2, "port": 3}
    worker = (SYSTEMD / (old["unit"] + ".service")).read_text()
    rendered = render(worker, sample, numbers, 4, 5)
    management = read_json(old["root"] / "management/config.json") or {}
    login_log = old["root"] / "evidence/login.private"
    memory = int(re.search(r"MemAvailable:\s+(\d+)", Path("/proc/meminfo").read_text()).group(1)) // 1024
    checks = {
        "firewall_generator_matches_template": template_firewall_matches(),
        "template_guard_ready": guard_ok(old["root"], read_json(old["root"] / "egress/config.json")["exit_guard"]["expected_ip"]),
        "template_containers_running": seat["State"]["Running"] and egress["State"]["Running"],
        "template_mounts_are_binds": all(m["Type"] == "bind" for m in seat["Mounts"] + egress["Mounts"]),
        "seat_arguments_build": bool(docker_arguments(seat, sample, numbers, "seat")),
        "egress_arguments_build": bool(docker_arguments(egress, sample, numbers, "egress")),
        "worker_unit_renders": all(token in rendered for token in (
            sample["container"], "--binding 4 ", "--org 5 ", "--private-host 172.30.250.10 --port 3 ")),
        "ingress_units_present": all((SYSTEMD / (old["ingress"] + ext)).exists() for ext in (".socket", ".service")),
        "management_files_present": {"home", "binding", "container", "unit", "guard_file", "state_dir", "auth_latches",
                                     "health_url"} <= set(management)
                                    and (old["root"] / "management/management_agent.py").exists(),
        "worker_code_present": (old["root"] / "work/native-http/native_http.py").exists(),
        "login_link_parser_reads_template_log": not login_log.exists() or len(login_urls(login_log.read_text(errors="replace"))) == 1,
        "memory_available": memory >= CONFIG["min_free_mb"],
        "passwordless_sudo": subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode == 0,
    }
    return {"checks": checks, "passed": all(checks.values()), "memory_available_mb": memory}


def act_status(request):
    names = seat_names(request["seat"])
    if not names["root"].exists():
        return {"exists": False}
    allocation = allocation_of(names)
    running = existing("running")
    return {"exists": True,
            "allocation": {key: allocation.get(key) for key in ("octet", "port", "egress", "expected_ip", "binding", "org")},
            "containers": {"seat": names["container"] in running, "egress": names["container"] + "-egress" in running},
            "guard_ok": guard_ok(names["root"], allocation["expected_ip"]),
            "worker_unit": (SYSTEMD / (names["unit"] + ".service")).exists(),
            "ingress_unit": (SYSTEMD / (names["ingress"] + ".socket")).exists(),
            "live": (names["root"] / "live.marker").exists()}


# ---------------------------------------------------------------- provisioning actions

def act_prepare(request):
    """Network, firewall, guarded exit and the empty seat container. No account is involved yet."""
    names = seat_names(request["seat"])
    require(isinstance(request.get("egress"), str) and request["egress"] in egress_options(), "unknown_egress")
    option = egress_options()[request["egress"]]
    expected_ip = option["expected_ip"]
    require(request.get("expected_ip") == expected_ip, "egress_ip_changed", "the exit shown to the administrator is no longer the configured one")
    require(template_firewall_matches(), "template_firewall_differs")
    require(not names["root"].exists(), "seat_exists")
    require(not {names["container"], names["container"] + "-egress"} & set(existing("container")), "container_exists")
    require(names["container"] + "-net" not in existing("network"), "network_exists")
    require(names["chain"] not in sudo("iptables", "-t", "nat", "-S"), "firewall_chain_exists")
    require(observed_exit(option["proxy_url"]) == expected_ip, "egress_probe_failed", "the exit did not answer with its expected address")
    allocation = allocate()
    subnet, gateway = "172.30.%d.0/24" % allocation["octet"], "172.30.%d.1" % allocation["octet"]

    names["root"].mkdir(mode=0o700)
    for folder in SEAT_FOLDERS:
        (names["root"] / folder).mkdir(mode=0o700)
    record = {**allocation, "seat": names["seat"], "egress": request["egress"], "expected_ip": expected_ip, "at": time.time()}
    (names["root"] / "onboarding.json").write_text(json.dumps(record))

    run(["docker", "network", "create", "--driver", "bridge", "--subnet", subnet, "--gateway", gateway,
         "--opt", "com.docker.network.bridge.name=" + names["bridge"],
         "--opt", "com.docker.network.bridge.enable_ip_masquerade=false",
         "--opt", "com.docker.network.bridge.enable_icc=false",
         "--label", "owner=" + names["container"], names["container"] + "-net"])
    rules = firewall_rules(names["bridge"], names["chain"], subnet, allocation["tcp"], allocation["dns"])
    (names["root"] / "evidence/firewall.json").write_text(json.dumps(
        {"plan": {"add": rules["add"], "del": rules["delete"]}, "extra": rules["extra"],
         "remove": rules["delete"] + rules["delete_extra"]}))
    for rule in rules["extra"] + rules["add"]:
        sudo("iptables", "-w", "5", *rule)

    old = template()
    revision = str(uuid.uuid4())
    egress = json.loads(render((old["root"] / "egress/config.json").read_text(), names, allocation))
    egress["proxy_url"] = option["proxy_url"]
    egress["exit_guard"].update(expected_ip=expected_ip, revision=revision)
    (names["root"] / "egress/config.json").write_text(json.dumps(egress))
    create_like_template(names, allocation, "egress")
    for _ in range(90):
        state = guard_state(names["root"])
        if state.get("ready") or state.get("latched"):
            break
        time.sleep(.5)
    require(guard_ok(names["root"], expected_ip), "exit_guard_not_ready",
            {key: guard_state(names["root"]).get(key) for key in ("ready", "latched", "reason")})

    (names["root"] / "machine-id").write_text(uuid.uuid4().hex + "\n")
    shutil.copyfile(old["root"] / "resolv.conf", names["root"] / "resolv.conf")
    for name in ("machine-id", "resolv.conf"):
        (names["root"] / name).chmod(0o444)
    (names["root"] / "home/.rec/claude").mkdir(parents=True, mode=0o700)
    shutil.copyfile(old["root"] / "home/.rec/claude/claude.path", names["root"] / "home/.rec/claude/claude.path")
    create_like_template(names, allocation, "seat")

    worker = names["root"] / "work/native-http"
    worker.mkdir(mode=0o700)
    digests = {}
    for path in sorted((old["root"] / "work/native-http").iterdir()):
        if path.is_file() and (path.suffix == ".py" or path.name == "native-dispatch-proxy"):
            shutil.copy2(path, worker / path.name)
            digests[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    (worker / "state").mkdir(mode=0o700)
    (worker / "relay.key").write_text(secrets.token_urlsafe(48))
    (names["root"] / "evidence/worker-code-sha.json").write_text(json.dumps(digests))
    (names["root"] / "deployment.json").write_text(json.dumps(
        {"seat": names["seat"], "name": names["container"], "expected_ip": expected_ip, "guard_revision": revision,
         "limit": CONFIG["concurrency"], "image": inspect(names["container"])["Image"]}))
    return {"allocation": allocation, "expected_ip": expected_ip, "guard_revision": revision, "worker_files": len(digests)}


def act_prelogin(request):
    """The empty seat must leave through its expected address, seen by two independent services."""
    names = seat_names(request["seat"])
    allocation = allocation_of(names)
    seen = []
    for url in CONFIG["exit_probes"]:
        done = subprocess.run(["docker", "exec", names["container"], "curl", "-q", "--noproxy", "*", "--connect-timeout", "10",
                               "--max-time", "25", "-fsS", url], text=True, capture_output=True, timeout=40)
        address = done.stdout.strip()
        if url.endswith("/trace"):
            address = next((line[3:] for line in done.stdout.splitlines() if line.startswith("ip=")), "")
        seen.append({"source": url.split("/")[2], "ok": done.returncode == 0, "ip": address[:45]})
    proof = {"at": time.time(), "sources": seen, "guard_ok": guard_ok(names["root"], allocation["expected_ip"])}
    (names["root"] / "evidence/prelogin.safe.json").write_text(json.dumps(proof))
    require(proof["guard_ok"], "exit_guard_not_ready")
    require(all(row["ok"] and row["ip"] == allocation["expected_ip"] for row in seen), "exit_address_mismatch",
            [row["source"] for row in seen if not row["ok"] or row["ip"] != allocation["expected_ip"]])
    return proof


def native_command(names, *arguments):
    return ["docker", "exec", "-w", "/work", names["container"], "env", "-i", "HOME=/home/reclaude", "USER=reclaude",
            "LOGNAME=reclaude", "PATH=/opt/native:/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "TZ=UTC",
            "RECLAUDE_AUTO_UPDATE=0", CONFIG["native_cli"], *arguments]


def act_login_start(request):
    """Start the native device login once. Its output stays in a private log on this host."""
    names = seat_names(request["seat"])
    allocation = allocation_of(names)
    org = request.get("org")
    require(type(org) is int and 0 < org < 10 ** 9, "invalid_org")
    # Asked again after the runner restarted: the one login this seat gets has already begun, and may
    # even have been approved meanwhile. Its state is read by login_status; nothing is started twice.
    if (names["root"] / "evidence/login.intent").exists():
        return {"login_started": True, "already": True}
    proof = read_json(names["root"] / "evidence/prelogin.safe.json") or {}
    require(time.time() - proof.get("at", 0) < 900 and guard_ok(names["root"], allocation["expected_ip"]), "exit_not_verified")
    require(not (names["root"] / "home/.rec/state.json").exists(), "seat_already_has_native_state")
    with (names["root"] / "evidence/login.intent").open("x") as intent:
        intent.write(str(time.time()))
    with (names["root"] / "evidence/login.private").open("xb") as log:
        process = subprocess.Popen(native_command(names, "login", "--org", str(org)), stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, start_new_session=True)
    (names["root"] / "evidence/login.pid").write_text(str(process.pid))
    allocation["org"] = org
    (names["root"] / "onboarding.json").write_text(json.dumps(allocation))
    return {"login_started": True}


def act_login_status(request):
    names = seat_names(request["seat"])
    allocation = allocation_of(names)
    log = names["root"] / "evidence/login.private"
    text = log.read_text(errors="replace") if log.exists() else ""
    links = login_urls(text)
    current = names["root"] / "home/.rec/claude/current"
    binding = current.read_text().strip() if current.exists() else ""
    accounts = [path.parent.parent.name for path in (names["root"] / "home/.rec/claude/accounts").glob("*/config/.credentials.json")]
    pid = (names["root"] / "evidence/login.pid").read_text().strip() if (names["root"] / "evidence/login.pid").exists() else ""
    lowered = text.lower()
    return {"url": links[-1] if links else None,
            "bound": binding.isdigit() and accounts == [binding],
            "binding": int(binding) if binding.isdigit() else None,
            "running": bool(pid) and Path("/proc/" + pid).exists(),
            "problems": [word for word in ("timeout", "deadline exceeded", "connection refused", "device_revoked",
                                           "device_limit", "permission denied", "certificate", "expired") if word in lowered],
            "guard_ok": guard_ok(names["root"], allocation["expected_ip"])}


def native_state(names):
    state = read_json(names["root"] / "home/.rec/state.json", {})
    identity = state.get("identities", {}).get("claude", {})
    return {"ready": bool(state.get("daemon", {}).get("running") and identity.get("gateway", {}).get("healthy")),
            "bindings": sorted(identity.get("bindings", {})), "error": (identity.get("last_error") or {}).get("kind")}


def act_native_start(request):
    """Start the seat's own native daemon and wait until its gateway is healthy."""
    names = seat_names(request["seat"])
    allocation = allocation_of(names)
    login = act_login_status(request)
    require(login["bound"], "device_not_bound")
    require(login["guard_ok"], "exit_guard_not_ready")
    if not native_state(names)["ready"]:
        attempt = len(list((names["root"] / "evidence").glob("native-start-*.private"))) + 1
        done = subprocess.run(native_command(names, "service", "start"), capture_output=True, timeout=90)
        (names["root"] / f"evidence/native-start-{attempt}.private").write_bytes(done.stdout + done.stderr)
        require(done.returncode == 0, "native_service_start_failed", f"exit {done.returncode}")
    state = native_state(names)
    for _ in range(40):
        if state["ready"]:
            break
        time.sleep(1)
        state = native_state(names)
    require(state["ready"] and not state["error"], "native_not_ready", state["error"] or "gateway not healthy")
    require(state["bindings"] == [str(login["binding"])], "native_binding_mismatch")
    allocation["binding"] = login["binding"]
    (names["root"] / "onboarding.json").write_text(json.dumps(allocation))
    return {"binding": login["binding"], "org": allocation["org"]}


HEALTH_INSIDE = """
import urllib.request, urllib.error
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    response = opener.open("http://%s:%d/healthz", timeout=4)
except urllib.error.HTTPError as error:
    response = error
print(response.read().decode())
"""


def health_inside(names, allocation):
    """The host firewall drops replies from the seat network, so ask from inside the container."""
    script = HEALTH_INSIDE % ("172.30.%d.10" % allocation["octet"], allocation["port"])
    done = subprocess.run(["docker", "exec", names["container"], "python3", "-c", script],
                          capture_output=True, text=True, timeout=20)
    return json.loads(done.stdout)


def health_loopback(port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(f"http://127.0.0.1:{port}/healthz", timeout=4)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return json.load(response)


def wait_healthy(probe):
    report = {}
    for _ in range(60):
        try:
            report = probe()
            if report.get("ok"):
                return report
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        time.sleep(.5)
    raise Refused("worker_not_healthy", report.get("failed"))


def install_unit(names, unit, text):
    """Install a unit file, or keep an identical one. Returns whether it changed."""
    target = SYSTEMD / unit
    if target.exists() and target.read_text() == text:
        return False
    staged = names["root"] / "evidence" / unit
    staged.write_text(text)
    sudo("install", "-m", "0644", str(staged), str(target))
    return True


def act_worker_install(request):
    """The HTTP worker unit, copied from the template with this seat's identity."""
    names = seat_names(request["seat"])
    allocation = allocation_of(names)
    require("binding" in allocation and "org" in allocation, "device_not_bound")
    require(guard_ok(names["root"], allocation["expected_ip"]), "exit_guard_not_ready")
    old = template()
    unit = names["unit"] + ".service"
    source = (SYSTEMD / (old["unit"] + ".service")).read_text()
    source = "\n".join(line for line in source.splitlines() if not line.startswith("# /")) + "\n"
    text = render(source, names, allocation, allocation["binding"], allocation["org"])
    if install_unit(names, unit, text):
        sudo("systemctl", "daemon-reload")
    sudo("systemctl", "enable", "--now", unit, timeout=120)
    report = wait_healthy(lambda: health_inside(names, allocation))
    require(report["pool"]["capacity"] == CONFIG["concurrency"], "worker_capacity_unexpected", report["pool"]["capacity"])
    return {"unit": unit, "capacity": report["pool"]["capacity"]}


def act_ingress_install(request):
    """Loopback access to the worker inside the seat's network namespace."""
    names = seat_names(request["seat"])
    allocation = allocation_of(names)
    old = template()
    namespace = inspect(names["container"])["NetworkSettings"]["SandboxKey"]
    require(namespace.startswith("/var/run/docker/netns/"), "container_namespace_unexpected")
    changed = False
    for extension in (".socket", ".service"):
        text = (SYSTEMD / (old["ingress"] + extension)).read_text()
        text = re.sub(r"NetworkNamespacePath=\S+", "NetworkNamespacePath=" + namespace, text)
        changed |= install_unit(names, names["ingress"] + extension, render(text, names, allocation))
    if changed:
        sudo("systemctl", "daemon-reload")
        sudo("systemctl", "stop", names["ingress"] + ".service", timeout=60)
    sudo("systemctl", "enable", "--now", names["ingress"] + ".socket", timeout=60)
    wait_healthy(lambda: health_loopback(allocation["port"]))
    return {"port": allocation["port"]}


def act_canary(request):
    """One short real request straight at the worker. Never repeated automatically."""
    names = seat_names(request["seat"])
    allocation = allocation_of(names)
    require(guard_ok(names["root"], allocation["expected_ip"]), "exit_guard_not_ready")
    evidence = names["root"] / "evidence"
    for record in sorted(evidence.glob("canary-*.safe.json")):
        earlier = read_json(record) or {}
        if earlier.get("passed"):
            return {**earlier, "reused": True}
    attempt = len(list(evidence.glob("canary-*.intent"))) + 1
    require(attempt <= MAX_CANARIES, "canary_attempts_exhausted")
    key = (names["root"] / "work/native-http/relay.key").read_text().strip()
    expected = "CHECK-" + secrets.token_hex(4).upper()
    body = {"model": CONFIG["canary_model"], "max_tokens": 64, "stream": True, "tools": [],
            "metadata": {"user_id": str(uuid.uuid4())},
            "messages": [{"role": "user", "content": "Reply exactly " + expected}]}
    with (evidence / f"canary-{attempt}.intent").open("x") as intent:
        json.dump({"at": time.time(), "model": body["model"], "posts": 1, "no_retry": True}, intent)
    call = urllib.request.Request(f"http://127.0.0.1:{allocation['port']}/v1/messages", data=json.dumps(body).encode(),
                                  headers={"x-api-key": key, "content-type": "application/json", "anthropic-version": "2023-06-01"})
    result, text, kinds, stop = {"model": body["model"], "attempt": attempt}, "", [], None
    started = time.monotonic()
    try:
        try:
            response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(call, timeout=150)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result["status"] = response.status
            raw = response.read(600000)
        if result["status"] == 200:
            for line in raw.splitlines():
                if not line.startswith(b"data:"):
                    continue
                event = json.loads(line[5:])
                kinds.append(event.get("type"))
                if event.get("type") == "content_block_delta":
                    text += event.get("delta", {}).get("text", "")
                if event.get("type") == "message_delta":
                    stop = event.get("delta", {}).get("stop_reason")
        else:
            try:
                result["error"] = str(json.loads(raw).get("error", {}).get("message"))[:120]
            except ValueError:
                result["error"] = "non_json"
    except Exception as error:  # recorded, then reported as a failed canary
        result["exception"] = type(error).__name__
    result.update(elapsed_s=round(time.monotonic() - started, 2),
                  passed=result.get("status") == 200 and text.strip() == expected and stop == "end_turn"
                  and kinds.count("message_stop") == 1 and "error" not in kinds)
    (evidence / f"canary-{attempt}.safe.json").write_text(json.dumps(result))
    require(result["passed"], "native_canary_failed", result.get("error") or result.get("exception") or f"status {result.get('status')}")
    return result


def act_manager_install(request):
    """The read/start/stop agent the console uses for this seat."""
    names = seat_names(request["seat"])
    allocation = allocation_of(names)
    old = template()
    folder = names["root"] / "management"
    if not (folder / "config.json").exists():
        for path in (old["root"] / "management").iterdir():
            if path.suffix == ".py":
                shutil.copyfile(path, folder / path.name)
        config = json.loads(render((old["root"] / "management/config.json").read_text(), names, allocation,
                                   allocation["binding"], allocation["org"]))
        config.update(expected_ip=allocation["expected_ip"], binding=allocation["binding"],
                      guard_revision=read_json(names["root"] / "deployment.json")["guard_revision"],
                      health_url=f"http://127.0.0.1:{allocation['port']}/healthz")
        config.pop("account_windows", None)  # official usage readers are attached separately
        (folder / "config.json").write_text(json.dumps(config))
    reports = {}
    for action in ("status", "verify_exit"):
        done = subprocess.run(["python3", str(folder / "management_agent.py"), str(folder / "config.json")],
                              input=json.dumps({"action": action}), capture_output=True, text=True, timeout=70)
        require(done.returncode == 0, "management_agent_failed", action)
        reports[action] = json.loads(done.stdout)
    status = reports["status"]
    require(status["http_ready"] and status["exit_guard"]["ready"] and not status["revoked"] and not status["failed_checks"],
            "management_status_not_ready", status.get("failed_checks"))
    return {"agent": str(folder / "management_agent.py"), "config": str(folder / "config.json"),
            "guard_file": str(names["root"] / "guard/exit-guard-state.json"),
            "guard_revision": read_json(names["root"] / "deployment.json")["guard_revision"],
            "binding": allocation["binding"], "org": allocation["org"], "port": allocation["port"]}


def act_relay_key(request):
    names = seat_names(request["seat"])
    return {"relay_key": (names["root"] / "work/native-http/relay.key").read_text().strip()}


def act_mark_live(request):
    names = seat_names(request["seat"])
    allocation_of(names)
    marker = names["root"] / "live.marker"
    if not marker.exists():
        marker.write_text(str(time.time()))
    return {"live": True}


def act_abandon(request):
    """Remove a seat that never went live. Its directory is kept under a new name for the record."""
    names = seat_names(request["seat"])
    if not names["root"].exists():
        return {"abandoned": True, "removed": []}
    require(not (names["root"] / "live.marker").exists(), "seat_is_live")
    removed = []
    for unit in (names["ingress"] + ".socket", names["ingress"] + ".service", names["unit"] + ".service"):
        if (SYSTEMD / unit).exists():
            subprocess.run(["sudo", "-n", "systemctl", "disable", "--now", unit], capture_output=True, timeout=120)
            sudo("rm", "-f", str(SYSTEMD / unit))
            removed.append(unit)
    if removed:
        sudo("systemctl", "daemon-reload")
    for container in (names["container"], names["container"] + "-egress"):
        if container in existing("container"):
            run(["docker", "rm", "-f", container], 90)
            removed.append(container)
    recorded = read_json(names["root"] / "evidence/firewall.json")
    if recorded:
        for rule in recorded["remove"]:
            subprocess.run(["sudo", "-n", "iptables", "-w", "5", *rule], capture_output=True, timeout=20)
        require(names["chain"] not in sudo("iptables", "-t", "nat", "-S"), "firewall_chain_not_removed")
        removed.append("firewall")
    if names["container"] + "-net" in existing("network"):
        run(["docker", "network", "rm", names["container"] + "-net"])
        removed.append("network")
    kept = names["root"].with_name(names["dir"] + ".abandoned-" + time.strftime("%Y%m%d%H%M%S"))
    names["root"].rename(kept)
    return {"abandoned": True, "removed": removed, "kept": kept.name}


ACTIONS = {name[len("act_"):]: function for name, function in list(globals().items()) if name.startswith("act_")}


def main(config_path):
    os.umask(0o077)
    CONFIG.update(json.loads(Path(config_path).read_text()))
    try:
        request = json.loads(sys.stdin.read(4096))
        require(isinstance(request, dict) and request.get("action") in ACTIONS, "unknown_action")
        print(json.dumps({"ok": True, **ACTIONS[request["action"]](request)}))
    except Refused as refusal:
        print(json.dumps({"ok": False, "error": refusal.code, "detail": refusal.detail}))
        return 1
    except Exception as error:  # reported by type only: messages may quote private paths
        print(json.dumps({"ok": False, "error": "agent_failed", "detail": type(error).__name__}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
