import json
from pathlib import Path
import tempfile
import unittest

import onboarding_happy as happy
from onboarding_happy import StepFailed

SEAT = "ab12cd34"


def location(seat, verb, method, gate):
    return f"""    location = /reclaude/v1/native-{seat}/v1/{verb} {{
        if ($server_port != 18080) {{ return 404; }}
        if ($request_method != {method}) {{ return 405; }}
        allow 192.0.2.20;
        deny all;
        if (!-f /var/lib/ingress/{seat}/{gate}) {{
            return 503 '{{"type":"error","error":{{"code":"relay_acceptance_pending"}}}}';
        }}
        limit_conn reclaude_requests 10;
        proxy_next_upstream off;
        proxy_buffering off;
        proxy_pass http://unix:/var/lib/ingress/{seat}/gateway.sock:/v1/{verb};
    }}
"""


def seat_route(seat):
    return location(seat, "models", "GET", "catalog-ready") + location(seat, "messages", "POST", "accepted")


NGINX = ("server {\n    listen 127.0.0.1:18080;\n    location = /healthz { return 200; }\n"
         "    # BEGIN template seats 100001 and 100002\n" + seat_route("100001") + seat_route("100002")
         + "    # END template seats 100001 and 100002\n    location / { return 404; }\n}\n")

LINK = """[Unit]
Description=Seat 100001 private tunnel to AgentNAS
[Service]
ExecStart=/usr/bin/ssh -N -T -i /root/.ssh/control -p 2222 -o ServerAliveInterval=15 -L 127.0.0.1:33011:127.0.0.1:18041 user@127.0.0.1
Restart=on-failure
"""
SOCKET = "[Socket]\nListenStream=/var/lib/ingress/100001/gateway.sock\nSocketMode=0660\n"
PROXY = "[Unit]\nDescription=Seat 100001 loopback gateway link\n[Service]\nExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:33016\n"

CONTAINER = {
    "Image": "sha256:image", "State": {"Running": True},
    "Config": {"Entrypoint": ["node"], "Cmd": ["/opt/vm2api/src/server.mjs"], "User": "", "Labels": {"vm2api.seat.org": "100001"}},
    "HostConfig": {"NetworkMode": "host", "RestartPolicy": {"Name": "unless-stopped"}, "ReadonlyRootfs": True,
                   "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"], "PidsLimit": 128, "Memory": 536870912,
                   "MemorySwap": 536870912, "NanoCpus": 750000000, "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=128m"}},
    "Mounts": [
        {"Type": "bind", "Source": "/private/100001/state", "Destination": "/state", "RW": True},
        {"Type": "bind", "Source": "/private/100001/state/gateway-v2.public.json",
         "Destination": "/opt/vm2api/src/config/gateway-v2.public.json", "RW": True},
        {"Type": "bind", "Source": "/releases/kernel", "Destination": "/opt/vm2api/image-bin/kin-api-kernel", "RW": False},
        {"Type": "bind", "Source": "/releases/api-protocol.mjs", "Destination": "/opt/vm2api/src/lib/pool/api-protocol.mjs", "RW": False},
    ],
}


class TextTests(unittest.TestCase):
    def test_numbers_are_replaced_only_as_whole_numbers_and_never_twice(self):
        text = "port 33011 and 133011 and 330110; seat 100001; link 33016"
        self.assertEqual(happy.substitute(text, [("100001", "33011"), (33011, 33016), (33016, 33900)]),
                         "port 33016 and 133011 and 330110; seat 33011; link 33900")

    def test_the_route_of_one_template_seat_reproduces_the_other(self):
        ours = happy.seat_locations(NGINX, "100001")
        theirs = happy.seat_locations(NGINX, "100002")
        self.assertEqual(happy.substitute("".join(ours), [("100001", "100002")]), "".join(theirs))

    def test_a_seat_block_carries_only_the_new_identity_and_stays_gated(self):
        block = happy.seat_block(NGINX, "100001", SEAT)
        self.assertEqual(block.splitlines()[0], "    # BEGIN vm2api onboarded seat " + SEAT)
        self.assertEqual(block.splitlines()[-1], "    # END vm2api onboarded seat " + SEAT)
        self.assertNotIn("100001", block)
        self.assertEqual(block.count(SEAT), 8)
        for needed in (f"/var/lib/ingress/{SEAT}/catalog-ready)", f"/var/lib/ingress/{SEAT}/accepted)", "deny all;",
                       f"proxy_pass http://unix:/var/lib/ingress/{SEAT}/gateway.sock:/v1/messages;"):
            self.assertIn(needed, block)

    def test_insertion_is_placed_above_the_template_idempotent_and_reversible(self):
        once = happy.insert_seat_block(NGINX, "100001", SEAT)
        self.assertEqual(happy.insert_seat_block(once, "100001", SEAT), once)
        self.assertLess(once.index("onboarded seat " + SEAT), once.index("# BEGIN template seats"))
        self.assertEqual(once.replace(happy.seat_block(NGINX, "100001", SEAT), ""), NGINX)
        twice = happy.insert_seat_block(once, "100001", "ffff0000")
        self.assertEqual(happy.remove_seat_block(happy.remove_seat_block(twice, SEAT), "ffff0000"), NGINX)
        self.assertEqual(happy.remove_seat_block(twice, "ffff0000"), once)
        self.assertEqual(happy.remove_seat_block(NGINX, SEAT), NGINX)

    def test_a_changed_template_or_a_foreign_route_is_refused(self):
        for broken, code in ((NGINX.replace("proxy_buffering off;", "proxy_buffering on;"), "route_render_unexpected"),
                             (NGINX.replace(seat_route("100001"), ""), "template_route_unexpected"),
                             (NGINX.replace("location / {", f"location = /reclaude/v1/native-{SEAT}/v1/models {{ }}\n    location / {{"),
                              "route_differs_from_template")):
            with self.assertRaises(StepFailed) as raised:
                happy.insert_seat_block(broken, "100001", SEAT)
            self.assertEqual(raised.exception.code, code)

    def test_units_are_the_templates_with_the_seat_and_its_ports(self):
        self.assertEqual(happy.template_ports(LINK, {"PORT": "33016"}), (33011, 18041, 33016))
        link = happy.FORWARD.sub("-L 127.0.0.1:33800:127.0.0.1:18850", happy.substitute(LINK, [("100001", SEAT)]))
        self.assertIn("Description=Seat ab12cd34 private tunnel", link)
        self.assertIn("-L 127.0.0.1:33800:127.0.0.1:18850 user@127.0.0.1", link)
        self.assertEqual(link.replace(SEAT, "100001").replace("33800", "33011").replace("18850", "18041"), LINK)
        pairs = [("100001", SEAT), (33011, 33800), (33016, 33805)]
        self.assertEqual(happy.substitute(SOCKET, pairs), SOCKET.replace("100001", SEAT))
        self.assertEqual(happy.substitute(PROXY, pairs), PROXY.replace("100001", SEAT).replace("33016", "33805"))
        self.assertEqual(happy.unit_body("# /etc/systemd/system/x.service\n[Unit]\nA=1"), "[Unit]\nA=1\n")

    def test_a_cloned_gateway_has_the_template_shape_and_its_own_state(self):
        arguments = happy.gateway_arguments(CONTAINER, "vm2api-reclaude-ab12cd34-gateway", SEAT, Path("/seats/x/state"), Path("/seats/x/env"))
        joined = " ".join(arguments)
        for needed in ("--read-only", "--cap-drop ALL", "--security-opt no-new-privileges:true", "--network host",
                       "--restart unless-stopped", "--memory 536870912", "--cpus 0.75", "--pids-limit 128",
                       "--label vm2api.seat.org=ab12cd34", "-v /seats/x/state:/state", "--env-file /seats/x/env",
                       "--mount type=bind,src=/releases/kernel,dst=/opt/vm2api/image-bin/kin-api-kernel,readonly",
                       "--tmpfs /tmp:rw,nosuid,nodev,size=128m"):
            self.assertIn(needed, joined)
        self.assertNotIn("/private/100001", joined)
        self.assertEqual(arguments[-4:], ["--entrypoint", "node", "sha256:image", "/opt/vm2api/src/server.mjs"])
        clone = {**CONTAINER, "Mounts": [
            {**CONTAINER["Mounts"][0], "Source": "/seats/x/state"}, {**CONTAINER["Mounts"][1], "Source": "/seats/x/state/gateway-v2.public.json"},
            *CONTAINER["Mounts"][2:]]}
        self.assertEqual(happy.gateway_shape(clone), happy.gateway_shape(CONTAINER))
        weaker = {**clone, "HostConfig": {**CONTAINER["HostConfig"], "ReadonlyRootfs": False}}
        self.assertNotEqual(happy.gateway_shape(weaker), happy.gateway_shape(CONTAINER))
        writable = {**CONTAINER, "Mounts": [*CONTAINER["Mounts"][:3], {**CONTAINER["Mounts"][3], "RW": True}]}
        with self.assertRaises(StepFailed):
            happy.gateway_arguments(writable, "n", SEAT, Path("/s"), Path("/e"))

    def test_the_console_entry_keeps_the_template_boundary_and_is_scoped_to_the_seat(self):
        template = {"node": "AgentNAS", "concurrency": 10, "models": ["m1", "m2"], "origin": "https://console.example",
                    "panel_me_url": "http://127.0.0.1:1/me", "id": "reclaude-agentnas-100001", "binding": 50001,
                    "runtime_command": ["ssh", "-o", "StrictHostKeyChecking=yes", "user@host", "python3 /t/agent.py /t/config.json"],
                    "official_quota": {"org_id": 100001}}
        facts = {"binding": 57100, "sub_account": 34100, "ledger_account": "ek_1", "expected_ip": "192.0.2.7",
                 "nas_agent": "/seat dir/agent.py", "nas_config": "/seat dir/config.json", "guard_file": "/g.json", "guard_revision": "rev"}
        paths = {"manager_state": Path("/root/manager-state/ab12cd34"), "state": Path("/root/seats/ab12cd34/state")}
        config = happy.manager_config(template, SEAT, "ReClaude · AgentNAS · 新席位", facts, paths, ["ssh", "broker@sub"])
        self.assertEqual((config["id"], config["binding"], config["sub_account"]), ("reclaude-agentnas-ab12cd34", 57100, 34100))
        self.assertEqual(config["runtime_command"][:-1], template["runtime_command"][:-1])
        self.assertEqual(config["runtime_command"][-1], "python3 '/seat dir/agent.py' '/seat dir/config.json'")
        self.assertEqual(config["sub_command"], ["ssh", "broker@sub", "seat-control ab12cd34"])
        self.assertEqual((config["origin"], config["panel_me_url"]), (template["origin"], template["panel_me_url"]))
        self.assertEqual(config["usage_ledger"], {"path": "/root/seats/ab12cd34/state/data/kin.db", "account_id": "ek_1"})
        self.assertNotIn("official_quota", config)
        self.assertNotIn("100001", str(config))

    def test_seat_names_are_derived_only_from_a_valid_id(self):
        host = happy.Happy({"ingress_root": "/var/lib/ingress"}, "/root")
        paths = host.paths(SEAT)
        self.assertEqual((paths["container"], paths["link"], str(paths["ingress"])),
                         ("vm2api-reclaude-ab12cd34-gateway", "reclaude-seat-ab12cd34-private-link.service", "/var/lib/ingress/ab12cd34"))
        for bad in ("../x", "AB12CD34", "ab12cd3", "ab12cd34/", 7):
            with self.assertRaises(StepFailed):
                host.paths(bad)

    def test_ports_skip_listeners_and_other_seats_and_an_abandoned_seat_gives_its_ports_back(self):
        with tempfile.TemporaryDirectory() as root:
            host = happy.Happy({"port_first": 33800, "port_count": 3}, root)
            for folder, link in (("0000aaaa.abandoned-20260101000000", 33800), ("0000bbbb", 33810)):
                (Path(root) / "seats" / folder).mkdir(parents=True)
                (Path(root) / "seats" / folder / "happy.json").write_text(json.dumps({"link": link, "gateway": link + 5}))
            host.listening = lambda: {22}
            self.assertEqual(host.allocate(SEAT), {"seat": SEAT, "link": 33800, "gateway": 33805})
            host.listening = lambda: {22, 33805}
            self.assertEqual(host.allocate(SEAT), {"seat": SEAT, "link": 33820, "gateway": 33825})
            host.listening = lambda: {33805, 33820}
            with self.assertRaises(StepFailed) as failed:
                host.allocate(SEAT)
            self.assertEqual(failed.exception.code, "no_free_port")


if __name__ == "__main__":
    unittest.main()
