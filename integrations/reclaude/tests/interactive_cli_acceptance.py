"""Real interactive CLI with an offline, bounded provider and caller MCP tool."""

import copy, json, os, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from native_interactive_session import InteractiveSession
from native_api_http import initialize_api_profile

cli = sys.argv[1]
with tempfile.TemporaryDirectory(prefix="airoam-pty-") as tmp:
    root = pathlib.Path(tmp).resolve()
    profile = root / "profile"
    profile.mkdir()
    directory = root / "session"
    if "--fresh" in sys.argv:
        profile = initialize_api_profile(root)
    else:
        (profile / ".claude.json").write_text(
            json.dumps(
                {
                    "hasCompletedOnboarding": True,
                    "lastOnboardingVersion": "2.1.321",
                    "numStartups": 1,
                    "projects": {str(directory): {"hasTrustDialogAccepted": True}},
                }
            )
        )
    env = {
        "HOME": str(root),
        "CLAUDE_CONFIG_DIR": str(profile),
        "PATH": os.environ["PATH"],
        "ANTHROPIC_API_KEY": "sk-offline-fixture-no-money",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "128",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_TELEMETRY": "1",
    }
    body = {
        "model": "claude-opus-5-5",
        "max_tokens": 128,
        "system": "Use the provided echo tool once, then respond with the result.",
        "messages": [{"role": "user", "content": "Please echo SYNTHETIC."}],
        "tools": [
            {
                "name": "echo",
                "description": "Echo text on the caller.",
                "input_schema": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                },
            }
        ],
    }
    session = InteractiveSession(
        directory,
        [cli, "--setting-sources", ""],
        env,
        body,
        timeout=15,
        dispatch_proxy=pathlib.Path(__file__).with_name("interactive_fixture_guard.py"),
        api_base="https://offline.invalid",
        history_profile=profile,
    )
    try:
        turns = []
        identities = []
        for i in range(4):
            if i == 2:
                identities.append(session.native_id)
                session.close(graceful=True)
                session = InteractiveSession(
                    directory,
                    [cli, "--setting-sources", ""],
                    env,
                    body,
                    timeout=15,
                    dispatch_proxy=pathlib.Path(__file__).with_name(
                        "interactive_fixture_guard.py"
                    ),
                    api_base="https://offline.invalid",
                    history_profile=profile,
                    restore=True,
                )
                assert session.native_id == identities[-1], (
                    "idle restart lost native identity"
                )
            events = list(session.request(body))
            turns.append(
                {
                    "events": [e["type"] for e in events],
                    "pending": len(session.pending_ids),
                    "checkpoint": json.loads(
                        (directory / "continuation.json").read_text()
                    )["status"],
                }
            )
            assert events[-1]["type"] == "message_stop"
            body["messages"] = copy.deepcopy(session.history)
            body["messages"].append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": next(iter(session.pending_ids)),
                            "content": "SYNTHETIC",
                        }
                    ]
                    if session.pending_ids
                    else "Continue with a second answer.",
                }
            )
        print(
            json.dumps(
                {
                    "turns": turns,
                    "dispatches": len(
                        list((directory / "dispatch").glob("*.consumed.json"))
                    ),
                    "argv_has_print": "-p" in session.native_cli_argv,
                    "real_provider_calls": 0,
                    "idle_restart_same_native_id": True,
                }
            )
        )
    except Exception:
        print(
            (directory / "interactive-terminal.private.log").read_text()[-6000:]
            if (directory / "interactive-terminal.private.log").exists()
            else "no terminal"
        )
        debug = directory / "interactive-debug.private.log"
        print(
            "\n".join(
                l[:500]
                for l in debug.read_text(errors="replace").splitlines()
                if "MCP" in l
            )[-5000:]
            if debug.exists()
            else "no debug"
        )
        print(
            json.dumps(
                {
                    "files": [p.name for p in directory.iterdir()],
                    "process_code": session.process.poll() if session.process else None,
                    "ui_ready": session.ui_ready.is_set(),
                }
            )
        )
        raise
    finally:
        session.close()
