"""The WKWebView report gate must reject workers left alive after failure."""
import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


class ReportGateTest(unittest.TestCase):
    def run_gate(self, reports):
        with tempfile.TemporaryDirectory(prefix='macro-wk-report-') as directory:
            paths = []
            for mode, report in reports.items():
                path = pathlib.Path(directory) / (mode + '.json')
                path.write_text(json.dumps(report), encoding='utf-8')
                paths.append(str(path))
            return subprocess.run(
                [sys.executable, str(pathlib.Path(__file__).with_name('check.py')), *paths],
                capture_output=True, text=True, timeout=10,
            )

    def reports(self):
        worker = {'messages': 0, 'errors': 1, 'terminated': True}
        return {
            'normal': {
                'mode': 'normal', 'failures': [], 'csp': [],
                'workers': [{'messages': 1, 'terminated': True} for _ in range(7)],
                'revisions': {'staleIgnored': True},
            },
            'blocked': {
                'mode': 'blocked', 'failures': [], 'error': 'Worker blocked',
                'workers': [copy.deepcopy(worker)], 'csp': [{'directive': 'worker-src'}],
            },
            'missing': {
                'mode': 'missing', 'failures': [], 'error': 'Worker missing',
                'workers': [copy.deepcopy(worker)], 'csp': [],
            },
        }

    def test_completed_and_terminated_reports_pass(self):
        result = self.run_gate(self.reports())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_failed_worker_must_terminate(self):
        for mode in ('blocked', 'missing'):
            with self.subTest(mode=mode):
                reports = self.reports()
                reports[mode]['workers'][0]['terminated'] = False
                result = self.run_gate(reports)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn(mode + ': worker did not terminate', result.stderr)


if __name__ == '__main__':
    unittest.main()
