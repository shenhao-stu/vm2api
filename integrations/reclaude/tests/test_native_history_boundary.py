import copy
import json
from pathlib import Path
import tempfile
import unittest

from native_bridge_session import history_shape, signature
from native_history_boundary import (BoundaryError, control_record, frozen_prefix,
                                     prefix_boundary, read_controls, write_controls,
                                     pending_record, read_pending, write_pending)


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.history = history_shape([
            {'role': 'user', 'content': 'first'},
            {'role': 'system', 'content': 'date', 'output_config': {'effort': 'high'}},
            {'role': 'assistant', 'content': 'answer'},
            {'role': 'user', 'content': 'second'},
            {'role': 'system', 'content': 'transient'},
            {'role': 'assistant', 'content': [
                {'type': 'tool_use', 'id': 'exact_call', 'name': 'Read',
                 'input': {'path': 'owned.txt'}}]}])
        self.tail = history_shape([
            {'role': 'user', 'content': [
                {'type': 'tool_result', 'tool_use_id': 'exact_call', 'content': 'intact'}]},
            {'role': 'system', 'content': 'current hint'}])

    def test_removal_keeps_exact_dialogue_and_current_tail(self):
        record = control_record(self.history)
        for removed in [[], [1], [4], [1, 4]]:
            incoming = [m for i, m in enumerate(self.history) if i not in removed] + self.tail
            restored, prefix = frozen_prefix(incoming, len(self.history),
                                            signature(self.history), signature, record)
            self.assertEqual(restored, self.history)
            self.assertEqual(incoming[prefix:], self.tail)

    def test_dialogue_tool_and_historical_control_changes_are_rejected(self):
        incoming = self.history[:4] + self.history[5:] + self.tail
        for index, field, value in [(0, 'content', [{'type': 'text', 'text': 'changed'}]),
                                    (1, 'content', [{'type': 'text', 'text': 'changed date'}]),
                                    (4, 'content', [{'type': 'text', 'text': 'lost tool'}])]:
            changed = copy.deepcopy(incoming)
            changed[index][field] = value
            with self.subTest(index=index), self.assertRaises(BoundaryError):
                frozen_prefix(changed, len(self.history), signature(self.history),
                              signature, control_record(self.history))
        inserted = incoming[:3] + history_shape([{'role': 'system', 'content': 'injected'}]) + incoming[3:]
        with self.assertRaises(BoundaryError):
            prefix_boundary(self.history, inserted)

    def test_legacy_recovery_requires_exact_existing_history_hash(self):
        incoming = self.history[:4] + self.history[5:] + self.tail[:1] + [self.history[4]]
        restored, prefix = frozen_prefix(incoming, len(self.history),
                                        signature(self.history), signature)
        self.assertEqual(restored, self.history)
        self.assertEqual(prefix, 5)
        for changed in [incoming[:-1], [m for m in incoming if m != self.history[1]]]:
            with self.assertRaises(BoundaryError):
                frozen_prefix(changed, len(self.history), signature(self.history), signature)

    def test_private_control_witness_is_durable_bound_and_immutable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            digest = signature(self.history)
            sha = write_controls(root, self.history, digest)
            state = {'history_length': len(self.history), 'history_sha256': digest,
                     'history_controls_sha256': sha}
            path = root / 'history-controls' / (digest + '.json')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            record = read_controls(root, state)
            self.assertEqual(record, control_record(self.history))
            self.assertTrue(all(item['message']['role'] == 'system' for item in record['systems']))
            self.assertNotIn('owned.txt', path.read_text())
            self.assertEqual(write_controls(root, self.history, digest), sha)
            frozen = path.read_bytes()
            path.write_bytes(b'{}')
            with self.assertRaises(BoundaryError):
                read_controls(root, state)
            with self.assertRaises(BoundaryError):
                write_controls(root, self.history, digest)
            path.write_bytes(frozen)
            with self.assertRaises(BoundaryError):
                read_controls(root, {**state, 'history_controls_sha256': '0' * 64})
            path.unlink()
            with self.assertRaises(BoundaryError):
                read_controls(root, state)

    def test_pending_witness_proves_original_boundary_before_accepting_input_update(self):
        incoming = copy.deepcopy(self.history + self.tail)
        incoming[5]['content'][0]['input'] = {'path': 'caller-normalized.txt'}
        original = copy.deepcopy(incoming)
        record = pending_record(self.history)
        restored, prefix = frozen_prefix(incoming, len(self.history), signature(self.history),
                                        signature, control_record(self.history), record)
        self.assertEqual(restored, self.history)
        self.assertEqual(prefix, len(self.history))
        self.assertEqual(incoming, original)
        for witness in (None, {**record, 'assistant': incoming[5]}):
            with self.assertRaises(BoundaryError):
                frozen_prefix(incoming, len(self.history), signature(self.history),
                              signature, control_record(self.history), witness)
        incoming[0]['content'][0]['text'] = 'changed earlier dialogue'
        with self.assertRaises(BoundaryError):
            frozen_prefix(incoming, len(self.history), signature(self.history),
                          signature, control_record(self.history), record)

    def test_pending_witness_is_private_immutable_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            digest = signature(self.history)
            sha = write_pending(root, self.history, digest)
            state = {'status': 'awaiting_tools', 'history_length': len(self.history),
                     'history_sha256': digest, 'history_pending_sha256': sha}
            path = root / 'history-pending' / (digest + '.json')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(read_pending(root, state), pending_record(self.history))
            for bad in ({**state, 'status': 'idle'}, {**state, 'history_pending_sha256': '0' * 64}):
                with self.assertRaises(BoundaryError):
                    read_pending(root, bad)
            path.write_text('{}')
            with self.assertRaises(BoundaryError):
                read_pending(root, state)
            with self.assertRaises(BoundaryError):
                write_pending(root, self.history, digest)
            path.unlink()
            with self.assertRaises(BoundaryError):
                read_pending(root, state)


if __name__ == '__main__':
    unittest.main()
