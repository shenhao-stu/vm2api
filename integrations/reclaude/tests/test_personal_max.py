import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from native_bridge_session import confirmed_personal_max, Session, ContractError


class TestPersonalMax(unittest.TestCase):
    def test_verified_binding(self):
        with tempfile.TemporaryDirectory() as d:
            r = Path(d)
            p = r / "accounts/17/config"
            p.mkdir(parents=True)
            current = r / "current"
            current.write_text("17")
            cred = p / ".credentials.json"
            good = {
                "subscriptionType": "max",
                "scopes": ["user:inference", "user:profile"],
            }
            cred.write_text(json.dumps({"claudeAiOauth": good}))
            init = {
                "subtype": "success",
                "response": {
                    "account": {
                        "apiProvider": "firstParty",
                        "subscriptionType": "Claude Max",
                    }
                },
            }
            self.assertTrue(confirmed_personal_max(p, init))
            for item in ("policy-limits.json", "remote-settings.json"):
                (p / item).touch()
                self.assertFalse(confirmed_personal_max(p, init))
                (p / item).unlink()
            for account in [
                {},
                {"apiProvider": "firstParty", "subscriptionType": "Claude Team"},
                {"apiProvider": "bedrock", "subscriptionType": "Claude Max"},
            ]:
                self.assertFalse(
                    confirmed_personal_max(
                        p, {"subtype": "success", "response": {"account": account}}
                    )
                )
            current.write_text("18")
            self.assertFalse(confirmed_personal_max(p, init))
            current.write_text("17")
            for field, value in [
                ("subscriptionType", "team"),
                ("subscriptionType", None),
                ("scopes", []),
            ]:
                cred.write_text(
                    json.dumps({"claudeAiOauth": dict(good, **{field: value})})
                )
                self.assertFalse(confirmed_personal_max(p, init))
            cred.unlink()
            self.assertFalse(confirmed_personal_max(p, init))
            actor = Mock()
            actor.process.poll.return_value = None
            actor.failed = False
            actor.personal_max_confirmed = True
            actor.personal_max_profile = p
            actor.initialize_response = init
            with self.assertRaisesRegex(ContractError, "scope_changed"):
                Session.prepare(actor)


if __name__ == "__main__":
    unittest.main()
