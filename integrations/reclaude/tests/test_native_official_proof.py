import copy
import unittest

from native_health import validate_official


class OfficialProofTests(unittest.TestCase):
    def setUp(self):
        self.proof = {
            "observed_at_ms": 1000000,
            "quota": {
                "status": 200,
                "data": {
                    "state": "active",
                    "status": "active",
                    "enabled": True,
                    "quota_usd": 80,
                    "used_usd": 12,
                },
            },
            "devices": {
                "status": 200,
                "data": [{"id": 123, "org_id": 456, "revoked_at": None}],
            },
        }

    def test_fresh_matching_official_state(self):
        validate_official(self.proof, 123, 456, 1000001)

    def test_wrong_organization_or_binding(self):
        for binding, org in [(123, 457), (124, 456), (True, 456), (123, 0)]:
            with self.subTest(binding=binding, org=org), self.assertRaises(ValueError):
                validate_official(self.proof, binding, org, 1000001)

    def test_stale_or_future_observation(self):
        for now in [999999, 1120000, float("nan"), float("inf")]:
            with self.subTest(now=now), self.assertRaises(ValueError):
                validate_official(self.proof, 123, 456, now)

    def test_nonfinite_or_negative_quota_fails_closed(self):
        for field in ["quota_usd", "used_usd"]:
            for value in ["NaN", "Infinity", "-Infinity", -1]:
                proof = copy.deepcopy(self.proof)
                proof["quota"]["data"][field] = value
                with self.subTest(field=field, value=value), self.assertRaises(
                    ValueError
                ):
                    validate_official(proof, 123, 456, 1000001)

    def test_revoked_duplicate_or_missing_device(self):
        for devices in [
            [],
            [{"id": 123, "org_id": 456, "revoked_at": 5}],
            self.proof["devices"]["data"] * 2,
        ]:
            proof = copy.deepcopy(self.proof)
            proof["devices"]["data"] = devices
            with self.subTest(devices=devices), self.assertRaises(ValueError):
                validate_official(proof, 123, 456, 1000001)

    def test_unavailable_exhausted_or_disabled_quota(self):
        for changes in [{"used_usd": 79.5}, {"enabled": False}, {"state": "waiting"}]:
            proof = copy.deepcopy(self.proof)
            proof["quota"]["data"].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_official(proof, 123, 456, 1000001)


if __name__ == "__main__":
    unittest.main()
