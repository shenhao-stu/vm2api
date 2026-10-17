"""Exercise installer credential preparation without running host installation."""

import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


def installer_function(source, name):
    start = re.search(rf"^{name}\(\) \{{.*$", source, re.MULTILINE)
    if start is None:
        raise AssertionError(f"Installer helper missing: {name}")
    if start.group().endswith("}"):
        return start.group()
    end = re.search(r"^\}$", source[start.end():], re.MULTILINE)
    if end is None:
        raise AssertionError(f"Installer helper incomplete: {name}")
    return source[start.start():start.end() + end.end()]


class InstallEnvTests(unittest.TestCase):
    def test_missing_port_preserves_credentials_and_prints_default_banner(self):
        source = (ROOT / "deploy/install.sh").read_text()
        helpers = [
            "info", "ok", "err", "gen_secret", "env_get", "env_set",
            "env_set_if_empty", "ensure_env", "print_login_banner",
        ]
        script = "\n".join([
            "set -euo pipefail",
            "RED= GREEN= BLUE= NC=",
            "DEFAULT_ADMIN_USER=admin",
            "DEFAULT_PORT=8787",
            "WROTE_DEFAULT_PASSWORD=0",
            *(installer_function(source, name) for name in helpers),
            "ensure_env",
            "print_login_banner",
        ])
        credentials = {
            "VM2API_ADMIN_PASSWORD": "existing-admin-secret",
            "VM2API_API_KEY": "existing-api-secret",
            "VM2API_DB_SECRET": "existing-db-secret",
        }
        content = "VM2API_ADMIN_USER=existing-admin\n" + "".join(
            f"{key}={value}\n" for key, value in credentials.items()
        )
        with tempfile.TemporaryDirectory(prefix="vm2api-installer-") as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text(content)
            env_file.chmod(0o644)
            result = subprocess.run(
                ["bash"], input=script, text=True, capture_output=True,
                env={**os.environ, "INSTALL_DIR": directory}, timeout=20,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("http://127.0.0.1:8787/cc#/login", result.stdout)
            self.assertEqual(env_file.read_text(), content)
            self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
            for secret in credentials.values():
                self.assertNotIn(secret, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
