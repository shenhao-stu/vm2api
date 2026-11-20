import copy
import json
from pathlib import Path
import re
import tempfile
import unittest

from onboarding_sub_broker import Broker, Refused, insert_after_relays

SEAT, KEY = "ab12cd34", "k" * 56
MODELS = {"claude-fable-5-2": "claude-fable-5-2", "claude-haiku-5-5": "claude-haiku-5-5"}


class FakeSub:
    """An in-memory stand-in for the Sub2API admin helper: accounts, groups, one user, keys, usage."""

    def __init__(self):
        self.ROOT = None
        self.writes = []
        self.accounts = {
            900: {"id": 900, "name": "reference", "status": "active", "type": "apikey", "schedulable": True, "concurrency": 10,
                  "priority": 11, "group_ids": [24, 8], "extra": {"busy_sticky_fallback_tags": ["tag:1"]},
                  "credentials": {"base_url": "http://bridge/reclaude/v1/native-900", "api_key": "reference-key",
                                  "model_mapping": dict(MODELS), "pool_mode": False}},
            901: {"id": 901, "name": "older relay", "status": "active", "type": "apikey", "schedulable": True,
                  "concurrency": 10, "priority": 11, "group_ids": [24, 8], "extra": {}, "credentials": {}},
        }
        self.groups = {
            8: {"id": 8, "name": "shared", "model_routing_enabled": True,
                "model_routing": {"claude-fable-*": [700, 901, 900, 701], "claude-opus-*": [700]}},
        }
        self.user = {"email": "admin@example.test", "allowed_groups": [5, 6]}
        self.keys, self.usage, self.next_id = {}, [], 1000
        self.fail_on = None

    def api(self, system, method, path, body=None, receipt=None):
        assert system == "sub" and (method == "GET" or receipt), "writes need a receipt"
        if method != "GET":
            assert receipt not in [name for name, _ in self.writes], "receipt names are used once"
            self.writes.append((receipt, f"{method} {path}"))
            if self.fail_on and self.fail_on in path and method == self.fail_on_method:
                raise SystemExit("HTTP 500")
        kind, _, rest = path.removeprefix("/api/v1/admin/").partition("/")
        number = int(rest.split("/")[0]) if rest else None
        if kind == "users":
            if method == "PUT":
                self.user["allowed_groups"] = list(body["allowed_groups"])
            return copy.deepcopy(self.user)
        table = self.accounts if kind == "accounts" else self.groups
        if method == "POST" and number is None:
            self.next_id += 1
            row = {"id": self.next_id, "status": "active", "schedulable": True, **copy.deepcopy(body)}
            table[row["id"]] = row
            return copy.deepcopy(row)
        if number not in table:
            raise SystemExit("HTTP 404")
        if method == "POST" and rest.endswith("/schedulable"):
            table[number]["schedulable"] = body["schedulable"]
        elif method == "PUT":
            table[number].update(copy.deepcopy(body))
        elif method == "DELETE":
            del table[number]
            return {}
        return copy.deepcopy(table[number])

    def db(self, name, sql):
        assert name == "sub2api"
        match = lambda pattern: re.fullmatch(pattern, sql)
        if found := match(r"select id from groups where deleted_at is null and name='([\w-]+)'"):
            return [{"id": row["id"]} for row in self.groups.values() if row["name"] == found[1]]
        if found := match(r"select id from accounts where deleted_at is null and credentials->>'base_url'='([^']+)'"):
            return [{"id": row["id"]} for row in self.accounts.values() if row["credentials"].get("base_url") == found[1]]
        if found := match(r"select credentials->>'api_key' as relay_key from accounts where id=(\d+)"):
            return [{"relay_key": self.accounts[int(found[1])]["credentials"]["api_key"]}]
        if found := match(r"select account_id from account_groups where group_id=(\d+)"):
            return [{"account_id": row["id"]} for row in self.accounts.values() if int(found[1]) in row["group_ids"]]
        if found := match(r"select id from api_keys where group_id=(\d+) and deleted_at is null"):
            return [{"id": key} for key, group in self.keys.items() if group == int(found[1])]
        if found := match(r"select id, account_id from usage_logs where api_key_id=(\d+) order by id"):
            return [row for row in self.usage if row["key"] == int(found[1])]
        if found := match(r"select id from (groups|accounts) where id=(\d+) and deleted_at is null"):
            table = self.groups if found[1] == "groups" else self.accounts
            return [{"id": int(found[2])}] if int(found[2]) in table else []
        raise AssertionError("unexpected query: " + sql)


class OfflineBroker(Broker):
    """Everything that leaves the process is replaced: the public matcher, the user session, the model call."""

    def __init__(self, config, native):
        super().__init__(config, native)
        self.public, self.route, self.posts = set(), (503, {"error": {"code": "relay_acceptance_pending"}}), 0
        self.reply, self.bill_to = {"status": 200, "complete": True}, "seat"

    def set_public_paths(self, seat, blocked):
        changed = (seat in self.public) != blocked
        (self.public.add if blocked else self.public.discard)(seat)
        return changed

    def route_probe(self, seat, key):
        return self.route

    def public_status(self, seat):
        return 404 if seat in self.public else 401

    def caddy_state(self):
        return {}

    def caddy_validate(self):
        pass

    def user_session(self):
        return {"token": "session", "refresh": None}

    def user_api(self, session, method, path, body=None):
        if method == "POST":
            assert body["group_id"] in self.native.user["allowed_groups"], "the user must be granted the group first"
            self.native.next_id += 1
            self.native.keys[self.native.next_id] = body["group_id"]
            return {"data": {"id": self.native.next_id, "key": "sk-acceptance", "group_id": body["group_id"]}}
        del self.native.keys[int(path.rsplit("/", 1)[1])]
        return {}

    def canary_request(self, key):
        self.posts += 1
        key_id = next(iter(self.native.keys))
        account = self.stage(SEAT)["account_id"] if self.bill_to == "seat" else 901
        if self.reply.get("complete"):
            self.native.usage.append({"id": len(self.native.usage) + 1, "account_id": account, "key": key_id})
        return dict(self.reply)


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.sub = FakeSub()
        lock = Path(self.temp.name) / "release.lock"
        lock.touch()
        self.broker = OfflineBroker({
            "root": self.temp.name, "native_api_path": "/unused", "reference_account": 900, "routing_groups": [8],
            "relay_accounts": [900, 901], "base_url_prefix": "http://bridge/reclaude/v1/native-",
            "public_path_prefix": "/reclaude/v1/native-", "public_origin": "https://public.example",
            "account_name": "ReClaude · 共享 · {name} · {seat}", "canary_model": "claude-haiku-5-5",
            "release_lock": str(lock), "sub": {"admin_user": 1, "container": "sub", "url": "http://sub"}}, self.sub)
        self.create = {"seat": SEAT, "name": "新席位 A", "client_key": KEY, "binding": 57100, "org": 419000,
                       "expected_ip": "192.0.2.7"}

    def staged(self):
        self.broker.act_block_public({"seat": SEAT})
        created = self.broker.act_sub_create(self.create)
        self.broker.route = (200, {"data": [{"id": model} for model in MODELS]})
        return created

    def refused(self, call, request):
        with self.assertRaises(Refused) as raised:
            call(request)
        return raised.exception.code

    def test_new_relays_are_routed_right_behind_the_existing_ones(self):
        self.assertEqual(insert_after_relays([700, 901, 900, 701], 950, {900, 901}), [700, 901, 900, 950, 701])
        self.assertEqual(insert_after_relays([700, 950, 900], 950, {900}), [700, 950, 900])
        self.assertEqual(insert_after_relays([700, 701], 950, {900}), [700, 701])

    def test_the_account_is_a_copy_of_the_reference_in_its_own_acceptance_group(self):
        created = self.staged()
        account, group = self.sub.accounts[created["account_id"]], self.sub.groups[created["group_id"]]
        self.assertEqual(account["group_ids"], [group["id"]])
        self.assertTrue(group["is_exclusive"])
        self.assertEqual(group["model_allowlist"], {"enabled": True, "models": sorted(MODELS)})
        self.assertEqual(account["credentials"], {"base_url": "http://bridge/reclaude/v1/native-" + SEAT, "api_key": KEY,
                                                  "model_mapping": MODELS, "pool_mode": False})
        self.assertEqual((account["concurrency"], account["priority"], account["name"]),
                         (10, 11, "ReClaude · 共享 · 新席位 A · " + SEAT))
        self.assertNotIn("busy_sticky_fallback_tags", account["extra"])
        self.assertEqual(self.sub.user["allowed_groups"], [5, 6])
        self.assertEqual(self.sub.groups[8]["model_routing"]["claude-fable-*"], [700, 901, 900, 701])
        control = json.loads((Path(self.temp.name) / "seats" / SEAT / "control.json").read_text())
        self.assertEqual((control["account_id"], control["group_ids"]), (account["id"], [group["id"]]))

    def test_creating_again_changes_nothing_and_adopts_what_an_interrupted_run_left(self):
        first = self.staged()
        writes = len(self.sub.writes)
        self.assertEqual(self.broker.act_sub_create(self.create), first)
        self.assertEqual(len(self.sub.writes), writes)
        (Path(self.temp.name) / "seats" / SEAT / "sub.json").unlink()
        self.assertEqual(self.broker.act_sub_create(self.create), first)
        self.assertEqual(len(self.sub.accounts), 3)

    def test_unsafe_values_and_unreachable_routes_are_refused(self):
        self.broker.act_block_public({"seat": SEAT})
        for change, code in (({"name": "x'; drop"}, "invalid_name"), ({"client_key": "short"}, "invalid_client_key"),
                             ({"binding": "57100"}, "invalid_identity"), ({"expected_ip": "x y"}, "invalid_address"),
                             ({"seat": "../x"}, "invalid_seat")):
            with self.subTest(change=change):
                self.assertEqual(self.refused(self.broker.act_sub_create, {**self.create, **change}), code)
        self.assertEqual(len(self.sub.accounts), 2)
        self.broker.route = (0, {})
        self.assertEqual(self.refused(self.broker.act_sub_create, self.create), "private_route_unreachable")
        self.broker.route = (503, {"error": {"code": "relay_acceptance_pending"}})
        self.broker.public.clear()
        self.assertEqual(self.refused(self.broker.act_sub_create, self.create), "public_path_open")

    def test_acceptance_bills_one_request_to_the_seat_and_leaves_no_key_or_grant(self):
        self.staged()
        result = self.broker.act_sub_canary({"seat": SEAT})
        self.assertTrue(result["passed"])
        self.assertEqual((self.broker.posts, self.sub.keys, self.sub.user["allowed_groups"]), (1, {}, [5, 6]))
        again = self.broker.act_sub_canary({"seat": SEAT})
        self.assertTrue(again["reused"])
        self.assertEqual(self.broker.posts, 1)

    def test_acceptance_fails_when_the_request_was_billed_elsewhere_and_stops_after_three_attempts(self):
        self.staged()
        self.broker.bill_to = "other"
        for _ in range(3):
            self.assertEqual(self.refused(self.broker.act_sub_canary, {"seat": SEAT}), "sub_canary_failed")
            self.assertEqual((self.sub.keys, self.sub.user["allowed_groups"]), ({}, [5, 6]))
        self.assertEqual(self.refused(self.broker.act_sub_canary, {"seat": SEAT}), "canary_attempts_exhausted")
        self.assertEqual(self.broker.posts, 3)
        self.assertEqual(self.refused(self.broker.act_promote, {"seat": SEAT}), "not_accepted")

    def test_no_attempt_is_spent_while_the_route_is_closed(self):
        self.broker.act_block_public({"seat": SEAT})
        self.broker.act_sub_create(self.create)
        self.assertEqual(self.refused(self.broker.act_sub_canary, {"seat": SEAT}), "private_route_unreachable")
        self.assertEqual(self.broker.posts, 0)
        self.assertEqual(list((Path(self.temp.name) / "seats" / SEAT).glob("canary-*")), [])

    def test_promotion_joins_the_reference_groups_and_routes_and_removes_the_scaffolding(self):
        created = self.staged()
        self.broker.act_sub_canary({"seat": SEAT})
        promoted = self.broker.act_promote({"seat": SEAT})
        account = self.sub.accounts[created["account_id"]]
        self.assertEqual(account["group_ids"], [24, 8])
        self.assertEqual(account["extra"]["busy_sticky_fallback_tags"], ["tag:1"])
        self.assertEqual(account["credentials"]["api_key"], KEY)
        self.assertEqual(self.sub.groups[8]["model_routing"],
                         {"claude-fable-*": [700, 901, 900, created["account_id"], 701], "claude-opus-*": [700]})
        self.assertNotIn(created["group_id"], self.sub.groups)
        self.assertEqual(promoted["routes"], [{"group": 8, "models": ["claude-fable-*"]}])
        control = json.loads((Path(self.temp.name) / "seats" / SEAT / "control.json").read_text())
        self.assertEqual(control["group_ids"], [24, 8])
        writes = len(self.sub.writes)
        self.broker.act_promote({"seat": SEAT})
        self.assertEqual(len(self.sub.writes), writes)
        self.broker.act_mark_live({"seat": SEAT})
        self.assertEqual(self.refused(self.broker.act_abandon, {"seat": SEAT}), "seat_is_live")

    def test_a_second_seat_is_routed_behind_the_first(self):
        first = self.staged()
        self.broker.act_sub_canary({"seat": SEAT})
        self.broker.act_promote({"seat": SEAT})
        other = "ffff0000"
        self.broker.act_block_public({"seat": other})
        self.broker.route = (200, {"data": [{"id": model} for model in MODELS]})
        second = self.broker.act_sub_create({**self.create, "seat": other, "client_key": "j" * 56})
        self.sub.usage.clear()
        self.broker.canary_request = lambda key: (self.sub.usage.append(
            {"id": 9, "account_id": second["account_id"], "key": next(iter(self.sub.keys))}) or {"status": 200, "complete": True})
        self.broker.act_sub_canary({"seat": other})
        self.broker.act_promote({"seat": other})
        self.assertEqual(self.sub.groups[8]["model_routing"]["claude-fable-*"],
                         [700, 901, 900, first["account_id"], second["account_id"], 701])

    def test_abandon_reverses_a_staged_seat_and_a_promoted_one(self):
        for promote in (False, True):
            with self.subTest(promoted=promote):
                self.setUp()
                created = self.staged()
                if promote:
                    self.broker.act_sub_canary({"seat": SEAT})
                    self.broker.act_promote({"seat": SEAT})
                result = self.broker.act_abandon({"seat": SEAT})
                self.assertEqual(result["left"], [])
                self.assertNotIn(created["account_id"], self.sub.accounts)
                self.assertNotIn(created["group_id"], self.sub.groups)
                self.assertEqual(self.sub.groups[8]["model_routing"]["claude-fable-*"], [700, 901, 900, 701])
                self.assertEqual((self.broker.public, self.sub.user["allowed_groups"], self.sub.keys), (set(), [5, 6], {}))
                self.assertFalse((Path(self.temp.name) / "seats" / SEAT).exists())
                self.assertEqual(self.broker.act_abandon({"seat": SEAT})["removed"], [])

    def test_admin_api_errors_become_refusals_instead_of_ending_the_process(self):
        self.broker.act_block_public({"seat": SEAT})
        self.sub.fail_on, self.sub.fail_on_method = "/accounts", "POST"
        self.assertEqual(self.refused(self.broker.act_sub_create, self.create), "sub_api_failed")
        self.sub.fail_on = None
        created = self.broker.act_sub_create(self.create)
        self.assertEqual(len(self.sub.groups), 2)
        self.assertEqual(self.sub.accounts[created["account_id"]]["group_ids"], [created["group_id"]])


if __name__ == "__main__":
    unittest.main()
