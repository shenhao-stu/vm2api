import socket
import unittest

from native_service_control import check_bind


class ServiceControlTests(unittest.TestCase):
    def test_live_listener_is_never_treated_as_free(self):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", 0))
            server.listen()
            with self.assertRaises(OSError):
                check_bind(*server.getsockname())

    def test_completed_health_connection_does_not_prevent_restart(self):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", 0))
            address = server.getsockname()
            server.listen()
            with socket.create_connection(address) as client:
                accepted, _ = server.accept()
                accepted.close()
                self.assertEqual(client.recv(1), b"")
        check_bind(*address)
