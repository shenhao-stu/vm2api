import copy
import json
import os
from pathlib import Path
import tempfile
import unittest

from expire_sub import (
    AdminAPI, EXPIRES_AT, MARKER_KEY, MODEL, NoRedirect,
    expiration_applied, expiration_patch, group_expiration_patch,
    is_fable52, maintain_expirations, maintain_group_expirations, private_read, timestamp,
)


def fixture():
    spec = {"account_id": 202, "base_url": "http://127.0.0.1:18000", "expires_at": EXPIRES_AT, "marker": "test-fable52"}
    account = {
        "id": 202, "platform": "anthropic", "type": "apikey",
        "credentials": {"base_url": spec["base_url"], "header_overrides": {"x-example": "preserved"}, "model_mapping": {
            "claude-sonnet-5-5": "claude-sonnet-5-5", MODEL: MODEL,
            "claude-fable-5.2[1m]": MODEL, "launch-alias": "claude-fable-5-2[1m]",
        }},
        "extra": {"trusted_namespace": "unchanged", "other_rule": {"active": True}, MARKER_KEY: {
            "marker": spec["marker"], "tier": "pro", "model": MODEL, "expires_at": EXPIRES_AT,
        }},
        "status": "active", "schedulable": True, "concurrency": 1,
        "priority": 0, "group_ids": [3, 9], "affinity": "private-user",
    }
    return account, spec


class ExpiryTests(unittest.TestCase):
    def setUp(self):
        self.now = timestamp(EXPIRES_AT)

    def test_exact_expiry_boundary_and_only_target_changes(self):
        account, spec = fixture()
        original = copy.deepcopy(account)
        self.assertIsNone(expiration_patch(account, spec, self.now - 0.001))
        patch = expiration_patch(account, spec, self.now)
        self.assertEqual(set(patch), {"credentials", "extra"})
        self.assertEqual(patch["credentials"]["model_mapping"], {"claude-sonnet-5-5": "claude-sonnet-5-5"})
        self.assertEqual(patch["credentials"]["header_overrides"], account["credentials"]["header_overrides"])
        self.assertEqual(patch["extra"], {"trusted_namespace": "unchanged", "other_rule": {"active": True}})
        self.assertEqual(account, original)

    def test_dedicated_isolation_and_all_non_target_fields_are_preserved(self):
        account, spec = fixture()
        patch = expiration_patch(account, spec, self.now)
        after = {**account, **patch}
        for name in ("affinity", "group_ids", "status", "schedulable", "concurrency", "priority"):
            self.assertEqual(after[name], account[name])
        self.assertTrue(expiration_applied(after, spec))
        self.assertIsNone(expiration_patch(after, spec, self.now))

    def test_unmarked_max_relay_and_foreign_marker_are_untouched(self):
        for marker in (None, {"marker": "other-owner"}):
            account, spec = fixture()
            account["extra"][MARKER_KEY] = marker
            self.assertIsNone(expiration_patch(account, spec, self.now))
        account, spec = fixture()
        del account["extra"][MARKER_KEY]
        self.assertIsNone(expiration_patch(account, spec, self.now))
        account["extra"][MARKER_KEY] = {"marker": spec["marker"], "tier": "max", "model": MODEL, "expires_at": EXPIRES_AT}
        with self.assertRaisesRegex(ValueError, "promotion_identity_mismatch"):
            expiration_patch(account, spec, self.now)

    def test_account_binding_and_promotion_expiry_must_match(self):
        for target, value in (("base_url", "http://127.0.0.1:19999"), ("base_url", "https://example.invalid/")):
            account, spec = fixture()
            account["credentials"][target] = value
            with self.assertRaisesRegex(ValueError, "account_binding_mismatch"):
                expiration_patch(account, spec, self.now)
        account, spec = fixture()
        account["extra"][MARKER_KEY]["expires_at"] = "2026-11-18T07:59:00Z"
        with self.assertRaisesRegex(ValueError, "promotion_expiry_mismatch"):
            expiration_patch(account, spec, self.now)
        account, spec = fixture()
        account["id"] = 203
        with self.assertRaisesRegex(ValueError, "account_identity_mismatch"):
            expiration_patch(account, spec, self.now)

    def test_removed_aliases_and_remaining_models_are_exact(self):
        for model in (MODEL, "claude-fable-5.2", MODEL + "[1m]", "claude-fable-5.2[1m]"):
            self.assertTrue(is_fable52(model))
        for model in ("claude-fable-5", "claude-fable-5-1", "claude-fable-5-20", "claude-opus-5-5"):
            self.assertFalse(is_fable52(model))
        account, spec = fixture()
        account["credentials"]["model_mapping"]["claude-fable-5-1"] = "claude-fable-5-1"
        patch = expiration_patch(account, spec, self.now)
        self.assertIn("claude-fable-5-1", patch["credentials"]["model_mapping"])

    def test_empty_mapping_and_permissive_wildcards_cannot_broaden_access(self):
        for mapping in ({MODEL: MODEL}, {MODEL: MODEL, "claude-*": "passthrough"}, {MODEL: MODEL, "*": "*"}):
            account, spec = fixture()
            account["credentials"]["model_mapping"] = mapping
            with self.assertRaises(ValueError):
                expiration_patch(account, spec, self.now)

    def test_group_cleanup_only_removes_the_given_pro_ids_from_exact_routes(self):
        group = {"id": 3, "model_routing_enabled": True, "model_routing": {
            MODEL: [202, 203, 300], "claude-fable-5.2": [202],
            "claude-fable-*": [300, 202], "claude-sonnet-5-5": [202],
        }}
        before = copy.deepcopy(group)
        patch = group_expiration_patch(group, [202, 203])
        self.assertEqual(patch, {"model_routing": {
            MODEL: [300], "claude-fable-*": [300, 202], "claude-sonnet-5-5": [202],
        }})
        self.assertEqual(group, before)
        self.assertIsNone(group_expiration_patch({**group, **patch}, [202, 203]))

    def group_update(self, fail=False, account_expired=True):
        account, spec = fixture()
        if account_expired:
            account.update(expiration_patch(account, spec, self.now))
        group = {"id": 3, "platform": "anthropic", "model_routing_enabled": True,
                 "model_routing": {MODEL: [202, 300, 400], "claude-fable-*": [300, 400]},
                 "fallback_group_id": 99}
        config = {"group_id": 3, "account_ids": [202], "marker": spec["marker"], "expires_at": EXPIRES_AT}
        calls = []
        def api(method, route, body=None):
            calls.append((method, route))
            if route.endswith("accounts/202"):
                return copy.deepcopy(account)
            self.assertEqual(route, "/api/v1/admin/groups/3")
            if method == "PUT":
                self.assertEqual(set(body), {"model_routing"})
                group.update(copy.deepcopy(body))
                if fail:
                    raise TimeoutError("lost_after_commit")
            return copy.deepcopy(group)
        result = maintain_group_expirations([config], [spec], api, self.now)
        return result, group, calls

    def test_group_cli_flow_preserves_max_fallback_and_flags(self):
        reports, group, calls = self.group_update()
        self.assertEqual(reports[0]["action"], "expired")
        self.assertEqual(group["model_routing"][MODEL], [300, 400])
        self.assertEqual(group["model_routing"]["claude-fable-*"], [300, 400])
        self.assertEqual(group["fallback_group_id"], 99)
        self.assertTrue(group["model_routing_enabled"])
        self.assertEqual(sum(method == "PUT" for method, _ in calls), 1)

    def test_group_lost_write_response_is_read_back_not_replayed(self):
        reports, _, calls = self.group_update(fail=True)
        self.assertEqual(reports[0]["action"], "reconciled")
        self.assertEqual(sum(method == "PUT" for method, _ in calls), 1)

    def test_group_does_not_mutate_before_verified_account_expiry(self):
        reports, _, calls = self.group_update(account_expired=False)
        self.assertEqual(reports[0]["reason"], "account_expiry_unconfirmed")
        self.assertFalse(any(method == "PUT" for method, _ in calls))

    def test_group_only_accepts_registered_pro_specs_and_same_promotion(self):
        _, spec = fixture()
        def api(*_args):
            self.fail("invalid scope made an API call")
        config = {"group_id": 3, "account_ids": [300], "marker": spec["marker"], "expires_at": EXPIRES_AT}
        reports = maintain_group_expirations([config], [spec], api, self.now)
        self.assertEqual(reports[0]["reason"], "group_account_promotion_mismatch")
        config["account_ids"] = [202]
        reports = maintain_group_expirations([config], [spec], api, self.now - 1)
        self.assertEqual(reports[0]["action"], "not_due")

    def test_no_admin_calls_before_expiry(self):
        _, spec = fixture()
        def api(*_args):
            self.fail("premature API call")
        self.assertEqual(maintain_expirations([spec], api, self.now - 1)[0]["action"], "not_due")

    def run_update(self, after_commit=False, before_commit=False):
        account, spec = fixture()
        calls = []
        def api(method, route, body=None):
            calls.append(method)
            self.assertEqual(route, "/api/v1/admin/accounts/202")
            if method == "PUT":
                self.assertEqual(set(body), {"credentials", "extra"})
                if before_commit:
                    raise TimeoutError("not_committed")
                account.update(copy.deepcopy(body))
                if after_commit:
                    raise TimeoutError("response_lost")
            return copy.deepcopy(account)
        reports = maintain_expirations([spec], api, self.now)
        self.assertEqual(calls, ["GET", "PUT", "GET"])
        return reports

    def test_normal_update_is_verified_by_fresh_read(self):
        self.assertEqual(self.run_update()[0]["action"], "expired")

    def test_lost_write_response_is_reconciled_without_retry(self):
        self.assertEqual(self.run_update(after_commit=True)[0]["action"], "reconciled")

    def test_failed_write_is_unconfirmed_and_not_replayed_in_the_same_run(self):
        self.assertEqual(self.run_update(before_commit=True)[0]["action"], "unconfirmed")

    def test_fresh_read_preserves_sensitive_credential_omission(self):
        account, spec = fixture()
        patch = expiration_patch(account, spec, self.now)
        self.assertNotIn("api_key", patch["credentials"])
        # Native MergePreservingSensitiveCreds retains this omitted key.
        preserved = {"api_key": "test-only-placeholder", **patch["credentials"]}
        self.assertEqual(preserved["api_key"], "test-only-placeholder")

    def test_errors_do_not_echo_upstream_exception_text(self):
        _, spec = fixture()
        def api(*_args):
            raise RuntimeError("private-test-token")
        result = maintain_expirations([spec], api, self.now)
        self.assertNotIn("private-test-token", json.dumps(result))

    def test_loopback_admin_auth_never_redirects_or_uses_remote_targets(self):
        for base in ("https://127.0.0.1:8080", "http://localhost:8080", "http://example.invalid", "http://127.0.0.1/path", "http://user:pass@127.0.0.1", "http://127.0.0.1/?x=1"):
            with self.assertRaises(ValueError):
                AdminAPI(base, "test-placeholder")
        AdminAPI("http://127.0.0.1:8080", "test-placeholder")
        AdminAPI("http://[::1]:8080", "test-placeholder")
        with self.assertRaises(ValueError):
            NoRedirect().redirect_request(None)
        with self.assertRaises(ValueError):
            AdminAPI("http://127.0.0.1:8080", "injected\nheader")

    def test_private_files_reject_public_permissions_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config"
            path.write_text("{}")
            os.chmod(path, 0o600)
            self.assertEqual(private_read(str(path), 16), "{}")
            link = path.with_name("link")
            link.symlink_to(path)
            with self.assertRaises(OSError):
                private_read(str(link), 16)
            os.chmod(path, 0o644)
            with self.assertRaises(ValueError):
                private_read(str(path), 16)


if __name__ == "__main__":
    unittest.main()
