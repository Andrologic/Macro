#!/usr/bin/env python3
"""Check the three JSON reports emitted by the isolated WKWebView bench."""
import json
import pathlib
import sys

if len(sys.argv) != 4:
    sys.exit('Usage: check.py NORMAL BLOCKED MISSING')
for expected, filename in zip(('normal', 'blocked', 'missing'), sys.argv[1:]):
    report = json.loads(pathlib.Path(filename).read_text())
    if report.get('mode') != expected or report.get('failures'):
        sys.exit(f'{expected}: failed or incorrect report: {report.get("failures")}')
    workers = report.get('workers', [])
    if expected == 'normal':
        if len(workers) != 7 or report.get('csp') or not report.get('revisions', {}).get('staleIgnored'):
            sys.exit('normal: missing worker, unexpected CSP error, or stale revision')
        if not all(worker.get('messages') == 1 and worker.get('terminated') for worker in workers):
            sys.exit('normal: a worker did not complete and terminate')
    elif not report.get('error') or not workers or not workers[0].get('errors'):
        sys.exit(f'{expected}: worker failure was not observed')
    elif not all(worker.get('terminated') is True for worker in workers):
        sys.exit(f'{expected}: worker did not terminate')
    elif expected == 'blocked' and not any(item.get('directive', '').startswith('worker-src') for item in report.get('csp', [])):
        sys.exit('blocked: CSP violation was not observed')
    print(f'{expected}: PASS')
