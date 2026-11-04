import contextlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import native_http


class NativeBodyLimitTests(unittest.TestCase):
    def launch(self, extra):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            argv = ['native_http', '--home', str(root), '--root', str(root),
                    '--key-file', str(root / 'unused.key'), '--dispatch-proxy', 'unused',
                    '--binding', '1', '--org', '1', '--model', 'fixture', *extra]
            server = SimpleNamespace(server_address=('127.0.0.1', 0), accepted=0,
                                     pool=SimpleNamespace(prepared_idle_seconds=120),
                                     serve_forever=lambda: None, server_close=lambda: None)
            with (patch('sys.argv', argv), patch.object(native_http, 'NativeHealth'),
                  patch.object(native_http, 'load_relay_key', return_value='fixture-only'),
                  patch.object(native_http.signal, 'signal'),
                  patch.object(native_http, 'NativeServer', return_value=server) as create):
                native_http.main()
            return create.call_args.kwargs['limits'], json.loads((root / 'server.ready.safe.json').read_text())

    def test_default_body_limit_remains_eight_mib(self):
        limits, _ = self.launch([])
        self.assertEqual(limits.body_bytes, 8 * 1024 * 1024)

    def test_explicit_body_budget_reaches_server_and_ready_receipt(self):
        limits, receipt = self.launch(['--max-body-mib', '16', '--concurrency', '10'])
        self.assertEqual(limits.body_bytes, 16 * 1024 * 1024)
        self.assertEqual(limits.concurrency, 10)
        self.assertEqual(receipt['max_body_bytes'], limits.body_bytes)

    def test_invalid_or_unbounded_body_budgets_fail_before_server_start(self):
        for value in ['0', '-1', '33', '128', '1.5']:
            with self.subTest(value=value), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as failure:
                    self.launch(['--max-body-mib', value])
                self.assertEqual(failure.exception.code, 2)
