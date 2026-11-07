"""Tests for the AgSDL 0.3.0 reference validator."""

import glob
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLING = os.path.dirname(HERE)
REPOSITORY = os.path.dirname(TOOLING)
sys.path.insert(0, TOOLING)

from agsdl import jsoninput, load_modules, validate_bytes  # noqa: E402
from agsdl.permissions import command_prefix, effect_for, effects_in_use, glob_matches  # noqa: E402
from agsdl.graph import Graph  # noqa: E402
from agsdl.mermaid import render  # noqa: E402
from agsdl.validator import load_module  # noqa: E402

CONFORMANCE = os.path.join(REPOSITORY, "conformance")
EXAMPLES = os.path.join(REPOSITORY, "examples")
HARNESSES = os.path.join(REPOSITORY, "harnesses")


def codes(report, severity):
    return sorted({d["code"] for d in report.diagnostics if d["severity"] == severity})


class ConformanceTest(unittest.TestCase):
    def test_cases_match_expectations(self):
        modules = load_modules(os.path.join(CONFORMANCE, "modules"))
        with open(os.path.join(CONFORMANCE, "expected.json"), encoding="utf-8") as handle:
            expected = json.load(handle)
        files = {os.path.basename(p)[:-5] for p in glob.glob(os.path.join(CONFORMANCE, "cases", "*.json"))}
        self.assertEqual(files, set(expected), "every case needs an expectation, and the reverse")
        for name, expectation in expected.items():
            with self.subTest(case=name):
                with open(os.path.join(CONFORMANCE, "cases", name + ".json"), "rb") as handle:
                    report = validate_bytes(handle.read(), modules)
                self.assertEqual(codes(report, "error"), expectation["errors"])
                self.assertEqual(codes(report, "warning"), expectation["warnings"])
                self.assertEqual(report.valid, not expectation["errors"])


class ExamplesTest(unittest.TestCase):
    def test_examples_are_valid(self):
        modules = load_modules(HARNESSES)
        paths = sorted(glob.glob(os.path.join(EXAMPLES, "*.json")))
        self.assertTrue(paths)
        for path in paths:
            with self.subTest(example=os.path.basename(path)):
                with open(path, "rb") as handle:
                    report = validate_bytes(handle.read(), modules)
                self.assertEqual(codes(report, "error"), [])
                self.assertNotIn("HARNESS_UNVERIFIED", codes(report, "warning"))


class ModulesTest(unittest.TestCase):
    def test_harness_modules_load(self):
        modules = load_modules(HARNESSES)
        for path in glob.glob(os.path.join(HARNESSES, "*", "module.json")):
            module = load_module(path)
            self.assertEqual(module["name"], os.path.basename(os.path.dirname(path)))
            self.assertIn(module["name"], modules)
            self.assertTrue(os.path.isfile(os.path.join(os.path.dirname(path), "CHANGELOG.md")))

    def test_module_settings_use_the_value_schema_subset(self):
        schemas = {}
        for name in ("agsdl", "harness-module"):
            with open(os.path.join(REPOSITORY, "schema", f"{name}.schema.json"), encoding="utf-8") as handle:
                schemas[name] = json.load(handle)
        self.assertEqual(schemas["harness-module"]["$defs"]["valueSchema"], schemas["agsdl"]["$defs"]["valueSchema"])


class JsonInputTest(unittest.TestCase):
    def reject(self, data):
        with self.assertRaises(jsoninput.InputError):
            jsoninput.parse_bytes(data)

    def test_rejections(self):
        self.reject(b'{"a": 1, "a": 2}')
        self.reject(b'{"a": NaN}')
        self.reject(b'{"a": Infinity}')
        self.reject(b'\xef\xbb\xbf{}')
        self.reject(b'{"a": "\xff"}')
        self.reject(b'{"a": "\\ud800"}')
        self.reject(b'{"a": 1} x')

    def test_numbers_stay_exact(self):
        value = jsoninput.parse_bytes(b'{"a": 0.1, "b": 10000000000000000000001}')
        self.assertEqual(str(value["a"]), "0.1")
        self.assertEqual(value["b"], 10000000000000000000001)

    def test_paired_surrogates_are_accepted(self):
        self.assertEqual(jsoninput.parse_bytes(b'"\\ud83d\\ude00"'), "\U0001F600")


class PermissionsTest(unittest.TestCase):
    def test_glob(self):
        self.assertTrue(glob_matches("git push*", "git push origin main"))
        self.assertTrue(glob_matches("git push *", "git push", command=True))
        self.assertTrue(glob_matches("git push *", "git push origin", command=True))
        self.assertFalse(glob_matches("git push *", "git pushx", command=True))
        self.assertFalse(glob_matches("git push *", "git push", paths=True))
        self.assertFalse(glob_matches("git push*", "git status"))
        self.assertTrue(glob_matches(".env*", ".env.local", paths=True))
        self.assertFalse(glob_matches("src/*", "src/a/b.py", paths=True))
        self.assertTrue(glob_matches("src/**", "src/a/b.py", paths=True))

    def test_most_restrictive_matching_rule_wins(self):
        permissions = {"preset": "workspace", "rules": [
            {"action": "shell", "match": "git *", "effect": "allow"},
            {"action": "shell", "match": "git push *", "effect": "ask"},
        ]}
        self.assertEqual(effect_for(permissions, "shell", "git push"), "ask")
        self.assertEqual(effect_for(permissions, "shell", "git status"), "allow")
        self.assertEqual(effect_for(permissions, "shell", "make"), "allow")
        self.assertEqual(effect_for(None, "shell", "make"), "deny")
        self.assertEqual(effect_for({"rules": []}, "read", "a.txt"), "deny")

    def test_command_prefix(self):
        for pattern in ("git push *", "rm", "npm run test"):
            self.assertTrue(command_prefix(pattern), pattern)
        for pattern in ("git push*", "git push * --force", "* --force", " *", "rm "):
            self.assertFalse(command_prefix(pattern), pattern)

    def test_effects_in_use(self):
        effects = effects_in_use({"rules": [{"action": "network", "effect": "allow"}]})
        self.assertEqual(effects["network"], {"allow"})
        self.assertEqual(effects["write"], {"deny"})
        self.assertEqual(effects_in_use("workspace")["write"], {"allow", "deny"})
        self.assertEqual(effects_in_use("full")["network"], {"allow"})
        # A universal pattern covers every use; a relative one only the workspace.
        self.assertEqual(effects_in_use({"rules": [{"action": "network", "match": "*", "effect": "allow"}]})["network"], {"allow"})
        self.assertEqual(effects_in_use({"rules": [{"action": "read", "match": "/**", "effect": "allow"}]})["read"], {"allow"})
        self.assertEqual(effects_in_use({"rules": [{"action": "read", "match": "**", "effect": "allow"}]})["read"], {"allow", "deny"})


class ReportTest(unittest.TestCase):
    def test_join_report(self):
        with open(os.path.join(CONFORMANCE, "cases", "join-direct-branch.json"), "rb") as handle:
            report = validate_bytes(handle.read(), load_modules(os.path.join(CONFORMANCE, "modules")))
        self.assertEqual(report.as_json()["joins"], {"merge": {"origin": "one", "branches": ["two", "one"]}})

    def test_composition_join_report(self):
        # A join in a composition is addressed by the step path of its use.
        with open(os.path.join(CONFORMANCE, "cases", "nested-compositions.json"), "rb") as handle:
            report = validate_bytes(handle.read(), load_modules(os.path.join(CONFORMANCE, "modules")))
        self.assertEqual(report.as_json()["joins"], {
            "review/check/vote": {"origin": "review/check/spread", "branches": ["r1", "r2", "r3"]},
        })

    def test_shape_failure_stops_checks(self):
        report = validate_bytes(b'{"contract": "agsdl-0.3.0", "id": "x"}', {})
        self.assertEqual(codes(report, "error"), ["SHAPE"])


class GraphTest(unittest.TestCase):
    def test_body_failure_reaches_its_branch_first(self):
        with open(os.path.join(EXAMPLES, "reusable-review.json")) as handle:
            document = json.load(handle)
        document["flow"]["steps"]["review"]["onError"] = "write"
        graph = Graph.for_flow(document, {"triple-review": {"first", "second", "third"}})
        failing = sorted("/".join(edge.src) for edge in graph.edges if edge.kind == "error")
        self.assertEqual(failing, ["review/spread", "review/vote"])


class MermaidTest(unittest.TestCase):
    def test_render(self):
        steps = {
            "write": {"type": "agent", "agent": "w", "next": "review"},
            "review": {"type": "agent", "agent": "r", "next": {"ready": [], "revise": "write"}, "onError": "merge"},
            "merge": {"type": "join", "title": 'Say "hi"'},
        }
        text = render(steps, "write")
        self.assertIn("s0 --> s1", text)
        self.assertIn("s1 -- ready --> finish", text)
        self.assertIn("s1 -- revise --> s0", text)
        self.assertIn("s1 -. error .-> s2", text)
        self.assertIn('s2(["Say #quot;hi#quot;"])', text)


if __name__ == "__main__":
    unittest.main()
