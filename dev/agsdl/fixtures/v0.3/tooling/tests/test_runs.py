"""Checks of the run scenarios in conformance/runs.

The repository runs no flow: these tests check that each scenario is well
formed, that its document is valid, and that every step it names exists.
Whether a host does what a scenario expects is for that host to test.
"""

import glob
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLING = os.path.dirname(HERE)
REPOSITORY = os.path.dirname(TOOLING)
sys.path.insert(0, TOOLING)

from agsdl import load_modules, validate_document  # noqa: E402
from agsdl.graph import Graph  # noqa: E402
from agsdl.schemacheck import SchemaChecker  # noqa: E402

CONFORMANCE = os.path.join(REPOSITORY, "conformance")

with open(os.path.join(REPOSITORY, "schema", "run-scenario.schema.json"), encoding="utf-8") as _handle:
    SCENARIO_SCHEMA = SchemaChecker(json.load(_handle))


def load_scenario_document(scenario):
    document = scenario["document"]
    if isinstance(document, str):
        with open(os.path.join(CONFORMANCE, document), encoding="utf-8") as handle:
            return json.load(handle)
    return document


def addressed(scenario):
    """Every (address, role) a scenario names."""
    for event in scenario["timeline"]:
        if "work" in event:
            yield event["work"], "work"
        for work in event.get("running", []):
            yield work["step"], "work"
    expect = scenario["expect"]
    for address in expect.get("starts", {}):
        yield address, "work"
    for message in expect.get("messages", []):
        yield message["to"], "work"
        for comment in message.get("comments", []):
            yield comment["step"], "approval"
    for join in expect.get("joins", []):
        yield join["join"], "join"
    for failure in expect.get("failures", []):
        yield failure["step"], "step"
    for work in expect.get("cancelled", []):
        yield work["step"], "work"
    for answer in expect.get("answers", []):
        yield answer["work"], "work"


class RunScenarioTest(unittest.TestCase):
    def test_scenarios_are_consistent(self):
        modules = load_modules(os.path.join(CONFORMANCE, "modules"))
        paths = sorted(glob.glob(os.path.join(CONFORMANCE, "runs", "*.json")))
        self.assertTrue(paths)
        for path in paths:
            with self.subTest(scenario=os.path.basename(path)):
                with open(path, encoding="utf-8") as handle:
                    scenario = json.load(handle)
                self.assertEqual(SCENARIO_SCHEMA.check(scenario), [])
                document = load_scenario_document(scenario)
                report = validate_document(document, modules)
                errors = [d for d in report.diagnostics if d["severity"] == "error"]
                self.assertEqual(errors, [], "a scenario runs a valid document")
                graph = Graph.for_flow(document)
                steps = {addr: node.type for addr, node in graph.nodes.items() if node.decl is not None}
                for addr in graph.composes:
                    steps.setdefault(addr, "compose")
                for address, role in addressed(scenario):
                    addr = tuple(address.split("/"))
                    self.assertIn(addr, steps, f"no step {address!r}")
                    if role == "join":
                        self.assertEqual(steps[addr], "join", f"{address!r} is not a join")
                    elif role == "approval":
                        self.assertEqual(steps[addr], "approval", f"{address!r} is not an approval")
                    elif role == "work":
                        self.assertNotEqual(steps[addr], "join", f"a join does no work: {address!r}")


if __name__ == "__main__":
    unittest.main()
