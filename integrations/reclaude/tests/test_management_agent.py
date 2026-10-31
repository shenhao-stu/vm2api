from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import management_agent as agent


class PendingToolDrainTests(unittest.TestCase):
    def test_stop_does_not_kill_pending_tool_session(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"state_dir": directory, "unit": "fixture.service"}
            state = {"http_active": True, "container_started_at": "same",
                     "daemon_pid": 1, "daemon_started_at_ms": 1}
            with patch.object(agent, "status", return_value=state), \
                    patch.object(agent, "health", return_value={
                        "active_requests": 0, "pool": {"pending_tools_sessions": 1}}), \
                    patch.object(agent, "run") as run:
                with self.assertRaisesRegex(ValueError, "pending_tool_sessions"):
                    agent.execute(config, "stop")
                run.assert_not_called()
                self.assertFalse((Path(directory) / "management-paused").exists())

    def test_stop_fails_closed_without_pending_session_visibility(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"state_dir": directory, "unit": "fixture.service"}
            with patch.object(agent, "status", return_value={"http_active": True,
                    "container_started_at": "same", "daemon_pid": 1,
                    "daemon_started_at_ms": 1}), \
                    patch.object(agent, "health", return_value={"active_requests": 0}), \
                    patch.object(agent, "run") as run:
                with self.assertRaisesRegex(ValueError, "pending_tool_sessions_unknown"):
                    agent.execute(config, "stop")
                run.assert_not_called()

    def test_stop_after_final_accounting_and_no_pending_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"state_dir": directory, "unit": "fixture.service"}
            state = {"http_active": True, "container_started_at": "same",
                     "daemon_pid": 1, "daemon_started_at_ms": 1}
            with patch.object(agent, "status", return_value=state), \
                    patch.object(agent, "health", side_effect=[
                        {"active_requests": 1, "pool": {"pending_tools_sessions": 0}},
                        {"active_requests": 0, "pool": {"pending_tools_sessions": 0}}]), \
                    patch.object(agent.time, "sleep"), patch.object(agent, "run") as run:
                agent.execute(config, "stop")
                run.assert_called_once_with(["sudo", "-n", "systemctl", "stop", "fixture.service"], 20)
