#!/usr/bin/env python3
"""Launch an actual Claude Code gateway client in a stable, private profile.

This does not create native ReClaude telemetry or repair a revoked binding.
"""
import argparse
import os
from pathlib import Path
import shutil
import stat
from urllib.parse import urlsplit


def gateway_url(value):
    url = urlsplit(value)
    local = url.hostname in {"localhost", "127.0.0.1", "::1"}
    if (not url.hostname or url.username or url.password or url.query or url.fragment
            or url.scheme not in {"http", "https"} or url.scheme == "http" and not local):
        raise ValueError("gateway must use HTTPS, or HTTP on loopback, without URL credentials")
    return value.rstrip("/")


def client_environment(base_url, state_dir, key_file, path):
    base_url = gateway_url(base_url)
    info = key_file.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError("gateway key must be a regular private file (0600 or stricter)")
    key = key_file.read_text().strip()
    if len(key) < 32 or not key.isascii() or any(c.isspace() for c in key):
        raise ValueError("invalid gateway key file")
    state_dir = state_dir.resolve()
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state_dir.stat().st_mode & 0o077:
        raise ValueError("client state directory must be private (0700)")
    home, profile = state_dir / "home", state_dir / "profile"
    for directory in (home, profile):
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or directory.stat().st_mode & 0o077:
            raise ValueError("client directories must be private and independent")
    if (profile / ".credentials.json").exists():
        raise ValueError("use a gateway-only profile, without native OAuth credentials")
    return {"PATH": path, "HOME": str(home), "CLAUDE_CONFIG_DIR": str(profile),
            "ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_AUTH_TOKEN": key,
            "NO_PROXY": "localhost,127.0.0.1,::1", "no_proxy": "localhost,127.0.0.1,::1",
            "LANG": "C.UTF-8", "TERM": "dumb"}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--claude-bin", default="claude")
    parser.add_argument("client_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    executable = shutil.which(args.claude_bin)
    if not executable:
        parser.error("official Claude Code executable was not found")
    try:
        environment = client_environment(args.base_url, args.state_dir, args.key_file, os.environ.get("PATH", "/usr/bin:/bin"))
    except (OSError, ValueError):
        parser.error("invalid private client configuration; check URL, paths, permissions and gateway-only profile")
    client_args = args.client_args[1:] if args.client_args[:1] == ["--"] else args.client_args
    os.execve(executable, [executable, *client_args], environment)


if __name__ == "__main__":
    main()
