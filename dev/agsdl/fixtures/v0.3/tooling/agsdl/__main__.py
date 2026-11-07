"""Command line: python3 -m agsdl [--json] [--modules DIR] DOCUMENT..."""

import argparse
import json
import sys

from .validator import MODULES_DIR, ModuleError, load_modules, validate_bytes


def main(argv=None):
    parser = argparse.ArgumentParser(prog="agsdl", description="Validate AgSDL 0.3.0 documents.")
    parser.add_argument("documents", nargs="+", metavar="DOCUMENT")
    parser.add_argument("--json", action="store_true", help="print JSON reports")
    parser.add_argument("--modules", default=MODULES_DIR, help="directory of harness modules")
    args = parser.parse_args(argv)
    try:
        modules = load_modules(args.modules)
    except ModuleError as error:
        print(f"agsdl: invalid harness module: {error}", file=sys.stderr)
        return 2
    status = 0
    reports = {}
    for path in args.documents:
        try:
            with open(path, "rb") as handle:
                data = handle.read()
        except OSError as error:
            print(f"agsdl: {error}", file=sys.stderr)
            return 2
        report = validate_bytes(data, modules)
        if not report.valid:
            status = 1
        if args.json:
            reports[path] = report.as_json()
            continue
        errors = sum(1 for d in report.diagnostics if d["severity"] == "error")
        warnings = len(report.diagnostics) - errors
        verdict = "valid" if report.valid else "invalid"
        print(f"{path}: {verdict} ({errors} errors, {warnings} warnings)")
        for item in report.diagnostics:
            print(f"  {item['severity']:<7}  {item['code']:<24} {item['path'] or '/'}  {item['message']}")
        for name, info in report.joins.items():
            print(f"  join {name}: origin {info['origin']}, branches {', '.join(info['branches'])}")
    if args.json:
        output = reports[args.documents[0]] if len(args.documents) == 1 else reports
        print(json.dumps(output, indent=2, ensure_ascii=False))
    return status


if __name__ == "__main__":
    sys.exit(main())
