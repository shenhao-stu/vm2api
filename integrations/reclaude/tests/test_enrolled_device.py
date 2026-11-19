from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from enrolled_device import EnrolledDevice
from management import ManagementError
from management_server import Server


class DeviceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def make(self, binding, **changes):
        config = dict(id=f"native-{binding}", binding=binding, org=binding + 10, sub_account=None,
                      expected_ip="192.0.2.9", guard_revision="v1", origin="https://console.example",
                      node="nas", name="enrolled", models=[], concurrency=0, enrollment_only=True,
                      runtime_command=["reader", str(binding)], state_dir=str(Path(self.tmp.name) / str(binding)))
        config.update(changes)
        return EnrolledDevice(config, call=lambda cmd, action: {
            "org": binding+10, "device": binding, "guard": {}, "running": True,
            "revoked": False, "failed_checks": [], "seat": None, "windows": None})

    def test_two_enrollments_are_distinct_and_cannot_schedule(self):
        a,b = self.make(1),self.make(2)
        with Server(("127.0.0.1", 0), [a, b]) as server:
            for item in (a,b):
                self.assertFalse(item.refresh()["sub"]["schedulable"])
                for op in ("start","stop","pause_schedule","resume_schedule"):
                    with self.assertRaises(ManagementError):
                        item.action(op, "id")
            self.assertEqual([x["binding"] for x in server.statuses()], [1,2])

    def test_duplicate_binding_and_foreign_enrollment_rejected(self):
        with self.assertRaises(ValueError):
            Server(("127.0.0.1", 0), [self.make(1), self.make(1, id="different")])
        with self.assertRaises(ManagementError):
            self.make(1, org=500).refresh()
        with self.assertRaises(ValueError):
            self.make(1, sub_account=77)
