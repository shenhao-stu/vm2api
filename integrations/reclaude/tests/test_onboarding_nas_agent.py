import json
from pathlib import Path
import tempfile
import unittest

import onboarding_nas_agent as agent

TEMPLATE = {"dir": "reclaude-org-100001", "container": "reclaude-native-org-100001", "org": "100001", "binding": "50001",
            "net": "172.30.21.", "bridge": "krc100001", "chain": "RC100001", "tcp": "42081", "dns": "42054", "port": "18041",
            "unit": "reclaude-native-http-100001", "ingress": "reclaude-seat-100001-guest-ingress", "label": "100001"}
UNIT = """[Unit]
Description=Seat 100001 native HTTP worker
[Service]
ExecStartPre=/usr/bin/docker exec -w /work/native-http reclaude-native-org-100001 python3 native_service_control.py prepare --binding 50001 --host 172.30.21.10 --port 18041
ExecStart=/usr/bin/docker exec -w /work/native-http reclaude-native-org-100001 python3 native_http.py --binding 50001 --org 100001 --private-host 172.30.21.10 --port 18041 --concurrency 10
"""


class AgentTextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        agent.CONFIG.clear()
        agent.CONFIG.update(vm_root=self.temp.name, home=self.temp.name + "/home", template=TEMPLATE,
                            login_hosts=["login.example"], allocation={})
        self.addCleanup(agent.CONFIG.clear)
        self.names = agent.seat_names("ab12cd34")
        self.allocation = {"octet": 63, "tcp": 42981, "dns": 42954, "port": 18850}

    def test_every_name_comes_from_a_valid_seat_id(self):
        self.assertEqual((self.names["container"], self.names["bridge"], self.names["chain"], self.names["unit"]),
                         ("reclaude-native-seat-ab12cd34", "krsab12cd34", "RSAB12CD34", "reclaude-native-http-seat-ab12cd34"))
        self.assertLessEqual(len(self.names["bridge"]), 15, "a Linux interface name holds 15 characters")
        self.assertEqual(self.names["root"], Path(self.temp.name) / "reclaude-seat-ab12cd34")
        for bad in ("../../etc", "AB12CD34", "ab12cd3", "ab12cd345", "", None, 12345678):
            with self.assertRaises(agent.Refused):
                agent.seat_names(bad)

    def test_the_worker_unit_is_the_template_with_only_the_identity_replaced(self):
        rendered = agent.render(UNIT, self.names, self.allocation, 57100, 419000)
        self.assertIn("reclaude-native-seat-ab12cd34 python3 native_http.py --binding 57100 --org 419000 "
                      "--private-host 172.30.63.10 --port 18850 --concurrency 10", rendered)
        self.assertIn("Description=Seat ab12cd34 native HTTP worker", rendered)
        for old in ("100001", "50001", "172.30.21.", "18041"):
            self.assertNotIn(old, rendered)
        back = agent.substitute(rendered, [("reclaude-native-seat-ab12cd34", TEMPLATE["container"]), ("Seat ab12cd34", "Seat 100001"),
                                           ("172.30.63.", "172.30.21."), (57100, 50001), (419000, 100001), (18850, 18041)])
        self.assertEqual(back, UNIT)

    def test_numbers_inside_longer_numbers_are_left_alone_and_values_are_not_rewritten(self):
        text = "port 18041 key 1180411 path /x18041y tcp 42081 dns 42054"
        result = agent.substitute(text, [(18041, 42081), (42081, 42054), (42054, 1)])
        self.assertEqual(result, "port 42081 key 1180411 path /x42081y tcp 42054 dns 1")

    def test_every_template_name_is_replaced_wherever_it_appears(self):
        text = " ".join(str(value) for value in TEMPLATE.values()) + " /vm/reclaude-org-100001/guard AgentNAS-ReClaude-100001"
        rendered = agent.render(text, self.names, self.allocation, 57100, 419000)
        for old in TEMPLATE.values():
            self.assertNotIn(old, rendered)
        self.assertIn("/vm/reclaude-seat-ab12cd34/guard AgentNAS-ReClaude-ab12cd34", rendered)
        self.assertIn("krsab12cd34 RSAB12CD34 42981 42954 18850", rendered)

    def test_a_seat_takes_free_numbers_and_an_abandoned_seat_gives_its_numbers_back(self):
        agent.CONFIG["allocation"] = {"octet_first": 63, "octet_last": 65, "dns_first": 42954, "tcp_first": 42981, "port_first": 18850}
        root = Path(self.temp.name)
        for folder, octet in (("reclaude-seat-ab12cd34", 64), ("reclaude-seat-0000aaaa.abandoned-20260101000000", 63)):
            (root / folder).mkdir()
            (root / folder / "onboarding.json").write_text(json.dumps({"octet": octet}))
        # Networks docker knows, then listening sockets: the third candidate's worker port is taken.
        answers = {"bash": "172.30.21.0/24 172.17.0.0/16 ", "ss": "tcp LISTEN 0 128 127.0.0.1:18852 0.0.0.0:*\n"}
        original = agent.run
        agent.run = lambda arguments, *rest, **more: answers[arguments[0]]
        self.addCleanup(setattr, agent, "run", original)
        self.assertEqual(agent.allocate(), {"octet": 63, "dns": 42954, "tcp": 42981, "port": 18850})
        (root / "reclaude-seat-0000bbbb").mkdir()
        (root / "reclaude-seat-0000bbbb/onboarding.json").write_text(json.dumps({"octet": 63}))
        with self.assertRaises(agent.Refused) as refused:
            agent.allocate()
        self.assertEqual(refused.exception.code, "no_free_allocation")

    def test_firewall_rules_confine_the_seat_and_removal_mirrors_creation(self):
        rules = agent.firewall_rules("krsab12cd34", "RSAB12CD34", "172.30.63.0/24", 42981, 42954)
        flat = [" ".join(rule) for rule in rules["add"] + rules["extra"]]
        self.assertIn("-t nat -A RSAB12CD34 -p tcp -j REDIRECT --to-ports 42981", flat)
        self.assertIn("-t nat -A RSAB12CD34 -p udp --dport 53 -j REDIRECT --to-ports 42954", flat)
        self.assertIn("-t filter -I FORWARD 1 -i krsab12cd34 ! -d 172.30.63.0/24 -j DROP", flat)
        self.assertIn("-t filter -I INPUT 1 -i krsab12cd34 -j DROP", flat)
        self.assertTrue(all("krsab12cd34" in rule or "RSAB12CD34" in rule for rule in flat))
        inserted = {(rule[3], *rule[5:]) for rule in rules["add"] + rules["extra"] if rule[2] == "-I"}
        deleted = {tuple(rule[3:]) for rule in rules["delete"] + rules["delete_extra"] if rule[1] == "filter"}
        self.assertEqual(inserted, deleted)
        self.assertIn(["-t", "nat", "-X", "RSAB12CD34"], rules["delete"])

    def test_the_recorded_template_firewall_must_match_the_generator(self):
        root = Path(self.temp.name) / TEMPLATE["dir"] / "evidence"
        root.mkdir(parents=True)
        rules = agent.firewall_rules("krc100001", "RC100001", "172.30.21.0/24", "42081", "42054")
        recorded = {"plan": {"add": rules["add"] + [["-t", "nat", "-C", "x"]], "del": rules["delete"]}, "extra": rules["extra"]}
        (root / "firewall.json").write_text(json.dumps(recorded))
        self.assertTrue(agent.template_firewall_matches())
        recorded["plan"]["add"][3][-1] = "ACCEPT"
        (root / "firewall.json").write_text(json.dumps(recorded))
        self.assertFalse(agent.template_firewall_matches())

    def test_only_authorization_links_on_known_hosts_are_shown(self):
        log = ("Open this URL in your browser to authorize this CLI session:\n"
               "\x1b[1mhttps://login.example/cli/auth?state=abc123&p=claude\x1b[0m\n"
               "docs https://login.example/docs/cli/start\n"
               "https://evil.example/cli/auth?state=abc123\nhttps://login.example.evil.test/cli/auth?state=1\n")
        self.assertEqual(agent.login_urls(log), ["https://login.example/cli/auth?state=abc123&p=claude"])
        self.assertEqual(agent.login_urls("Login successful."), [])

    def test_the_exit_guard_must_be_ready_unlatched_and_on_the_expected_address(self):
        guard = Path(self.temp.name) / "seat/guard"
        guard.mkdir(parents=True)
        good = {"ready": True, "latched": False, "expected_ip": "192.0.2.7", "observed_ip": "192.0.2.7"}
        for change, expected in (({}, True), ({"latched": True}, False), ({"ready": False}, False),
                                 ({"observed_ip": "198.51.100.1"}, False), ({"expected_ip": "198.51.100.1"}, False)):
            (guard / "exit-guard-state.json").write_text(json.dumps({**good, **change}))
            self.assertEqual(agent.guard_ok(guard.parent, "192.0.2.7"), expected)
        (guard / "exit-guard-state.json").unlink()
        self.assertFalse(agent.guard_ok(guard.parent, "192.0.2.7"))

    def test_actions_on_a_seat_that_was_never_prepared_are_refused_and_abandon_is_a_no_op(self):
        for action in ("prelogin", "login_status", "native_start", "worker_install", "canary", "manager_install", "mark_live"):
            with self.subTest(action=action):
                with self.assertRaises(agent.Refused) as raised:
                    agent.ACTIONS[action]({"seat": "ab12cd34"})
                self.assertEqual(raised.exception.code, "seat_not_prepared")
        self.assertEqual(agent.act_abandon({"seat": "ab12cd34"}), {"abandoned": True, "removed": []})
        self.assertEqual(agent.act_status({"seat": "ab12cd34"}), {"exists": False})

    def test_a_login_is_started_once_and_asking_again_never_starts_or_refuses_it(self):
        evidence = self.names["root"] / "evidence"
        evidence.mkdir(parents=True)
        (self.names["root"] / "onboarding.json").write_text(json.dumps({**self.allocation, "expected_ip": "192.0.2.7"}))
        # No fresh exit proof: a first login is refused before anything is started.
        with self.assertRaises(agent.Refused) as raised:
            agent.act_login_start({"seat": "ab12cd34", "org": 419000})
        self.assertEqual(raised.exception.code, "exit_not_verified")
        self.assertFalse((evidence / "login.intent").exists())
        # Once begun, a repeated request (runner restart) is answered without looking at the old proof,
        # even if the device was approved in the meantime.
        (evidence / "login.intent").write_text("1")
        (self.names["root"] / "home/.rec").mkdir(parents=True)
        (self.names["root"] / "home/.rec/state.json").write_text("{}")
        self.assertEqual(agent.act_login_start({"seat": "ab12cd34", "org": 419000}), {"login_started": True, "already": True})
        self.assertEqual(sorted(path.name for path in evidence.iterdir()), ["login.intent"])
        with self.assertRaises(agent.Refused) as raised:
            agent.act_login_start({"seat": "ab12cd34", "org": "419000"})
        self.assertEqual(raised.exception.code, "invalid_org")

    def test_a_live_seat_is_never_abandoned(self):
        self.names["root"].mkdir()
        (self.names["root"] / "onboarding.json").write_text(json.dumps(self.allocation))
        agent.act_mark_live({"seat": "ab12cd34"})
        with self.assertRaises(agent.Refused) as raised:
            agent.act_abandon({"seat": "ab12cd34"})
        self.assertEqual(raised.exception.code, "seat_is_live")
        self.assertTrue(self.names["root"].exists())


if __name__ == "__main__":
    unittest.main()
