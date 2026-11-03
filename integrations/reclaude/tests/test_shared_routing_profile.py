import copy
import json
from pathlib import Path
import unittest

from management_sub import matches_shared_profile


class SharedRoutingProfileTests(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).resolve().parents[1] / "shared-routing.example.json"
        self.profile = json.loads(path.read_text())
        self.profile["groups"] = [3, 5]
        self.account = {
            **self.profile["account"],
            "group_ids": [5, 3],
            "extra": dict(self.profile["extra"]),
            "credentials": {
                **self.profile["credentials"],
                "model_mapping": {m: m for m in self.profile["models"]},
                "temp_unschedulable_rules": copy.deepcopy(self.profile["cooldowns"]),
                "base_url": "https://relay.example", "api_key": "fixture"
            },
        }

    def test_distinct_credentials_can_use_one_policy(self):
        self.account["credentials"]["api_key"] = "another"
        self.account["credentials"]["base_url"] = "https://second.example"
        self.account["credentials"]["temp_unschedulable_rules"][1]["keywords"].reverse()
        self.assertTrue(matches_shared_profile(self.account, self.profile))

    def test_consumed_turn_cannot_become_a_failover_rule(self):
        self.account["credentials"]["temp_unschedulable_rules"].append({
            "error_code": 400, "scope": "account", "duration_minutes": 1,
            "keywords": ["native_request_consumed_no_replay"]
        })
        self.assertFalse(matches_shared_profile(self.account, self.profile))

    def test_wrong_routing_target_or_model_is_detected(self):
        for key, value in [("concurrency", 0), ("priority", 1), ("group_ids", [3]),
                           ("extra", {"affinity_tags": ["reserved"]})]:
            with self.subTest(key=key):
                self.assertFalse(matches_shared_profile({**self.account, key: value}, self.profile))
        del self.account["credentials"]["model_mapping"][self.profile["models"][0]]
        self.assertFalse(matches_shared_profile(self.account, self.profile))
