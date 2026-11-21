"""Static validation of AgSDL 0.3.0 documents."""

import json
import os
from collections import deque

from . import jsoninput, valueschema
from .graph import Graph, analyse_joins, open_body_forks, route_items, route_targets, step_routes
from .permissions import command_prefix, covers_all, effect_for, effects_in_use, normalize, outside, shell_denied
from .schemacheck import SchemaChecker, pointer

CONTRACT = "agsdl-0.3.0"
HERE = os.path.dirname(os.path.abspath(__file__))
REPOSITORY = os.path.dirname(os.path.dirname(HERE))
SCHEMA_DIR = os.path.join(REPOSITORY, "schema")
MODULES_DIR = os.path.join(REPOSITORY, "harnesses")

CALL_OUTCOMES = {"passed", "failed"}
NO_MESSAGE_TYPES = {"call", "join"}


def _load_schema(name):
    with open(os.path.join(SCHEMA_DIR, name), "rb") as handle:
        return SchemaChecker(json.loads(handle.read().decode("utf-8")))


DOCUMENT_SCHEMA = _load_schema("agsdl.schema.json")
MODULE_SCHEMA = _load_schema("harness-module.schema.json")


class ModuleError(Exception):
    """A harness module is unreadable or invalid."""


def article(word):
    return ("an " if word[0] in "aeiou" else "a ") + word


def expanded(addr):
    """The step path of a step inside an expanded composition, else None."""
    if len(addr) < 2 or addr[0].startswith("#"):
        return None
    return list(addr)


def instance_label(instance):
    return f"instance '{instance}'" if instance else "shared instance"


def scope_member(addr, prefix):
    """The step of the scope with this prefix that is, or contains, the step at addr."""
    if len(addr) > len(prefix) and addr[: len(prefix)] == prefix:
        return addr[len(prefix)]
    return None


def is_json_media(media_type):
    return media_type == "application/json" or media_type.endswith("+json")


# Modules ------------------------------------------------------------------


def load_module(path):
    try:
        module = jsoninput.load(path)
    except (OSError, jsoninput.InputError) as error:
        raise ModuleError(f"{path}: {error}") from None
    problems = MODULE_SCHEMA.check(module)
    if problems:
        where, message = problems[0]
        raise ModuleError(f"{path}: {where or '/'}: {message}")
    if "settings" in module:
        shape = SchemaChecker({"$ref": "#/$defs/valueSchema", "$defs": DOCUMENT_SCHEMA.root["$defs"]}).check(module["settings"])
        consistency = [] if shape else valueschema.consistency(module["settings"], ["settings"])
        if shape or consistency:
            where, message = (shape or consistency)[0]
            raise ModuleError(f"{path}: settings {where}: {message}")
    return module


def load_modules(directory=MODULES_DIR):
    modules = {}
    if not os.path.isdir(directory):
        return modules
    for entry in sorted(os.listdir(directory)):
        path = os.path.join(directory, entry, "module.json")
        if os.path.isfile(path):
            module = load_module(path)
            modules[module["name"]] = module
    return modules


# Report -------------------------------------------------------------------


class Report:
    def __init__(self):
        self.diagnostics = []
        self.joins = {}
        self._seen = set()

    def add(self, severity, code, parts, message, step=None):
        where = pointer(parts) if isinstance(parts, list) else parts
        base = (severity, code, where, message)
        key = base + (tuple(step or ()),)
        # A composition analysed on its own repeats what its expansions found.
        if key in self._seen or (step is None and base in self._seen):
            return
        self._seen.update((key, base))
        item = {"severity": severity, "code": code, "path": where, "message": message}
        if step is not None:
            item["step"] = list(step)
        self.diagnostics.append(item)

    def error(self, code, parts, message, step=None):
        self.add("error", code, parts, message, step)

    def warning(self, code, parts, message, step=None):
        self.add("warning", code, parts, message, step)

    @property
    def valid(self):
        return not any(d["severity"] == "error" for d in self.diagnostics)

    def as_json(self):
        return {
            "contract": CONTRACT,
            "valid": self.valid,
            "diagnostics": self.diagnostics,
            "joins": self.joins,
        }


# Entry points -------------------------------------------------------------


def validate_bytes(data, modules=None):
    report = Report()
    try:
        document = jsoninput.parse_bytes(data)
    except jsoninput.InputError as error:
        report.error("PARSE", "", str(error))
        return report
    return validate_document(document, modules, report)


def validate_document(document, modules=None, report=None):
    report = report or Report()
    modules = load_modules() if modules is None else modules
    problems = DOCUMENT_SCHEMA.check(document)
    if problems:
        for where, message in problems:
            report.error("SHAPE", where, message)
        return report
    Checker(document, modules, report).run()
    return report


# Semantic checks ------------------------------------------------------------


class Checker:
    def __init__(self, document, modules, report):
        self.doc = document
        self.modules = modules
        self.report = report
        self.agents = document["agents"]
        self.compositions = document.get("compositions", {})
        self.content = document.get("content", {})
        self.uses = {name: {"new": False, "steer": False, "choices": set(), "used": False} for name in self.agents}
        self.cycle = False

    def run(self):
        scopes = []
        if "flow" in self.doc:
            scopes.append((self.doc["flow"], ["flow"], None))
        for name, composition in self.compositions.items():
            scopes.append((composition, ["compositions", name], name))
        self.check_compositions()
        for container, where, composition in scopes:
            self.check_scope(container, where, composition)
        self.check_agents()
        if not self.cycle:
            self.check_graphs()
        self.check_completion_choices()
        self.check_harnesses()

    # Content references ---------------------------------------------------

    def check_content_uses(self, uses, parts):
        if isinstance(uses, str):
            return
        items = uses.items() if isinstance(uses, dict) else enumerate(uses)
        for key, use in items:
            if "ref" in use and use["ref"] not in self.content:
                self.report.error("REFERENCE", parts + [key, "ref"], f"no content named '{use['ref']}'")

    def check_message(self, message, parts):
        if "prompt" in message:
            self.check_content_uses(message["prompt"], parts + ["prompt"])
        if "resources" in message:
            self.check_content_uses(message["resources"], parts + ["resources"])

    # Compositions ---------------------------------------------------------

    def check_compositions(self):
        uses = {}
        for name, composition in self.compositions.items():
            uses[name] = []
            for step_name, step in composition["steps"].items():
                if step["type"] == "compose":
                    uses[name].append((step["composition"], ["compositions", name, "steps", step_name, "composition"]))
            exported = set()
            for step in composition["steps"].values():
                for _, _, route, _ in step_routes(step, []):
                    for kind, target, _, _ in route_targets(route, []):
                        if kind == "output":
                            exported.add(target)
            for index, output in enumerate(composition["outputs"]):
                if output not in exported:
                    self.report.error("COMPOSITION", ["compositions", name, "outputs", index], f"no route of composition '{name}' leaves through output '{output}'")
        state = {}

        def visit(name):
            state[name] = "active"
            for target, where in uses.get(name, []):
                if target not in uses:
                    continue
                if state.get(target) == "active":
                    self.cycle = True
                    self.report.error("COMPOSITION", where, f"composition '{target}' uses itself, directly or through other compositions")
                elif target not in state:
                    visit(target)
            state[name] = "done"

        for name in uses:
            if name not in state:
                visit(name)

    # Steps and routes -----------------------------------------------------

    def check_scope(self, container, where, composition):
        steps = container["steps"]
        parameters = set(self.compositions[composition].get("parameters", [])) if composition else set()
        outputs = set(self.compositions[composition]["outputs"]) if composition else set()
        entry = container["entry"]
        if entry not in steps:
            self.report.error("REFERENCE", where + ["entry"], f"no step named '{entry}'")
        elif steps[entry]["type"] == "join":
            self.report.error("ROUTES", where + ["entry"], f"the entry cannot be {article(steps[entry]['type'])}")
        for name, step in steps.items():
            self.check_step(name, step, where + ["steps", name], steps, parameters, outputs, composition)
        roots = ()
        if composition is None and "onError" in container:
            self.check_flow_error(container)
            roots = [target for kind, target, _, _ in route_targets(container["onError"], []) if kind == "step"]
        if entry in steps:
            self.check_reachability(entry, steps, where + ["steps"], roots)

    def check_agent_ref(self, ref, parts, parameters, composition):
        if isinstance(ref, str):
            if ref not in self.agents:
                self.report.error("REFERENCE", parts, f"no agent named '{ref}'")
            return
        name = ref["parameter"]
        if composition is None:
            self.report.error("REFERENCE", parts, "agent parameters exist only inside compositions")
        elif name not in parameters:
            self.report.error("REFERENCE", parts, f"composition '{composition}' has no parameter '{name}'")

    def check_step(self, name, step, parts, steps, parameters, outputs, composition):
        kind = step["type"]
        if kind == "agent":
            self.check_agent_ref(step["agent"], parts + ["agent"], parameters, composition)
            if "prompt" in step:
                self.check_content_uses(step["prompt"], parts + ["prompt"])
            if step.get("instance") == "new" and "delivery" in step:
                self.report.error("DELIVERY", parts + ["delivery"], "a fresh instance is never working: delivery cannot be used with instance \"new\"")
            if isinstance(step["agent"], str) and step["agent"] in self.agents:
                usage = self.uses[step["agent"]]
                usage["used"] = True
                usage["new"] |= step.get("instance") == "new"
                usage["steer"] |= step.get("delivery") == "steer"
        elif kind == "call" and "mcp" in step:
            server = step["mcp"]["server"]
            if server not in self.doc.get("mcpServers", {}):
                self.report.error("REFERENCE", parts + ["mcp", "server"], f"no MCP server named '{server}'")
        elif kind == "compose":
            self.check_compose(step, parts, parameters, composition)
        self.check_routes(step, parts, steps, outputs, composition)

    def check_compose(self, step, parts, parameters, composition):
        target = step["composition"]
        if target not in self.compositions:
            self.report.error("REFERENCE", parts + ["composition"], f"no composition named '{target}'")
            return
        declared = self.compositions[target]
        expected = set(declared.get("parameters", []))
        given = step.get("agents", {})
        for missing in sorted(expected - set(given)):
            self.report.error("COMPOSITION", parts + ["agents"], f"missing agent for parameter '{missing}'")
        for extra in sorted(set(given) - expected):
            self.report.error("COMPOSITION", parts + ["agents", extra], f"composition '{target}' has no parameter '{extra}'")
        for parameter, ref in given.items():
            self.check_agent_ref(ref, parts + ["agents", parameter], parameters, composition)
        outputs = set(declared["outputs"])
        keys = set(step["next"])
        if keys != outputs:
            self.report.error("COMPOSITION", parts + ["next"], f"routes must cover exactly the outputs {sorted(outputs)}")

    def check_routes(self, step, parts, steps, outputs, composition):
        kind = step["type"]
        nxt = step.get("next")
        is_map = isinstance(nxt, dict) and "step" not in nxt and "output" not in nxt
        if kind == "call" and is_map:
            if set(nxt) != CALL_OUTCOMES:
                self.report.error("ROUTES", parts + ["next"], "a call routes with a route, or a map with exactly passed and failed")
        elif kind == "approval":
            if not nxt:
                self.report.error("ROUTES", parts + ["next"], "an approval offers at least one choice")
        elif kind == "join" and (nxt is not None or "quorum" in step):
            if "quorum" in step:
                if not is_map or set(nxt) != {"reached", "missed"}:
                    self.report.error("ROUTES", parts + ["next"], "a quorum join routes with exactly reached and missed")
            elif step.get("failures") == "keep":
                if is_map and set(nxt) != {"done", "incomplete"}:
                    self.report.error("ROUTES", parts + ["next"], "a join that keeps failures routes with a route, or a map with exactly done and incomplete")
            elif is_map and set(nxt) != {"done"}:
                self.report.error("ROUTES", parts + ["next"], "a join without quorum routes with a route, or a map with only done")
        if kind == "join":
            if "quorum" in step and ("failures" in step or "maxFailures" in step):
                self.report.error("JOIN", parts + ["failures" if "failures" in step else "maxFailures"], "failures and maxFailures apply to all mode only; a quorum already keeps failed branches")
            elif "maxFailures" in step and step.get("failures") != "keep":
                self.report.error("JOIN", parts + ["maxFailures"], 'maxFailures requires failures: "keep"')
        if kind == "agent" and is_map and isinstance(step["agent"], str) and step["agent"] in self.agents:
            self.uses[step["agent"]]["choices"].update(nxt)
        for _, _, route, where in step_routes(step, parts):
            self.check_route(route, where, steps, outputs, composition)

    def check_route(self, route, where, steps, outputs, composition):
        items = route if isinstance(route, list) else [route]
        for index, item in enumerate(items):
            if not isinstance(item, dict) or "each" in item:
                continue
            at = where + [index] if isinstance(route, list) else where
            for key in ("concurrency", "max"):
                if key in item:
                    self.report.error("ROUTES", at + [key], f"{key} limits a fan-out; it requires each")
        seen = set()
        for tkind, target, message, at, each in route_items(route, where):
            if (tkind, target) in seen:
                self.report.error("DUPLICATE", at, f"'{target}' appears twice in this route")
            seen.add((tkind, target))
            if tkind == "step":
                if target not in steps:
                    self.report.error("REFERENCE", at, f"no step named '{target}'")
                elif message is not None and steps[target]["type"] in NO_MESSAGE_TYPES:
                    self.report.error("ROUTES", at + ["message"], f"{article(steps[target]['type'])} cannot receive a message")
                elif each is not None and steps[target]["type"] in NO_MESSAGE_TYPES:
                    self.report.error("ROUTES", at + ["each"], f"{article(steps[target]['type'])} receives no message, so it cannot tell the elements of a fan-out apart")

            else:
                if composition is None:
                    self.report.error("ROUTES", at, "outputs exist only inside compositions")
                elif target not in outputs:
                    self.report.error("REFERENCE", at, f"composition '{composition}' has no output '{target}'")
                if message is not None:
                    self.report.error("ROUTES", at + ["message"], "put the message on the compose step's route, not on the output")
            if message is not None:
                self.check_message(message, at + ["message"])

    def check_flow_error(self, flow):
        """The flow's onError: a default error route for top-level failures."""
        route = flow["onError"]
        where = ["flow", "onError"]
        self.check_route(route, where, flow["steps"], set(), None)

    def check_reachability(self, entry, steps, parts, roots=()):
        seen = {entry} | {root for root in roots if root in steps}
        queue = deque(seen)
        while queue:
            current = queue.popleft()
            for _, _, route, _ in step_routes(steps[current], []):
                for kind, target, _, _ in route_targets(route, []):
                    if kind == "step" and target in steps and target not in seen:
                        seen.add(target)
                        queue.append(target)
        origin = "the entry or the flow's onError" if roots else "the entry"
        for name in steps:
            if name not in seen:
                self.report.error("UNREACHABLE", parts + [name], f"step '{name}' cannot be reached from {origin}")

    # Agents ---------------------------------------------------------------

    def check_agents(self):
        skills = self.doc.get("skills", {})
        servers = self.doc.get("mcpServers", {})
        for name, agent in self.agents.items():
            parts = ["agents", name]
            if "instructions" in agent:
                self.check_content_uses(agent["instructions"], parts + ["instructions"])
            if "resources" in agent:
                self.check_content_uses(agent["resources"], parts + ["resources"])
            for index, skill in enumerate(agent.get("skills", [])):
                if skill not in skills:
                    self.report.error("REFERENCE", parts + ["skills", index], f"no skill named '{skill}'")
            for index, server in enumerate(agent.get("mcpServers", [])):
                if server not in servers:
                    self.report.error("REFERENCE", parts + ["mcpServers", index], f"no MCP server named '{server}'")
            for result_name, result in agent.get("results", {}).items():
                where = parts + ["results", result_name]
                if result_name == "text":
                    self.report.error("RESULT_NAME", where, "a result cannot be named 'text'")
                media = result.get("mediaType", "application/json")
                if "schema" in result:
                    if not is_json_media(media):
                        self.report.error("SCHEMA", where + ["schema"], f"a schema needs a JSON media type, not {media}")
                    for at, message in valueschema.consistency(result["schema"], where + ["schema"]):
                        self.report.error("SCHEMA", at, message)
            permissions = agent.get("permissions")
            if isinstance(permissions, dict) and permissions.get("preset") == "read-only":
                for path, access in permissions.get("directories", {}).items():
                    if access == "write":
                        self.report.error("PERMISSIONS", parts + ["permissions", "directories", path], "read-only never writes; this directory asks for write")
            check = agent.get("completionCheck")
            if check is not None:
                if effect_for(agent.get("permissions"), "shell", check["command"]) == "deny":
                    self.report.error("PERMISSIONS", parts + ["completionCheck", "command"], "the agent's own permissions deny this command")

    def check_completion_choices(self):
        """A completion check's choices must be choices that some step routes by."""
        for name, agent in self.agents.items():
            check = agent.get("completionCheck")
            usage = self.uses[name]
            if check is None or not usage["used"]:
                continue
            for index, choice in enumerate(check.get("choices", [])):
                if choice not in usage["choices"]:
                    self.report.error("REFERENCE", ["agents", name, "completionCheck", "choices", index], f"no step using agent '{name}' routes by choice '{choice}'")

    # Graphs ---------------------------------------------------------------

    def check_graphs(self):
        scopes = {}
        covered = set()
        if "flow" in self.doc and self.doc["flow"]["entry"] in self.doc["flow"]["steps"]:
            # The flow's onError acts as the onError of the steps it covers,
            # which excludes join branches: find them without it first.
            infos, _ = analyse_joins(Graph.for_scope(self.doc))
            members = {m[0] for info in infos.values() for found in info["branches"].values() for m in found}
            covered = Graph.flow_error_covered(self.doc, members)
            scopes[None] = Graph.for_scope(self.doc, covered=covered)
        for name, composition in self.compositions.items():
            if composition["entry"] in composition["steps"]:
                scopes[name] = Graph.for_scope(self.doc, name)
        # Joins are deduced in their own scope, where a compose step is one step.
        joins = {}
        for key, graph in scopes.items():
            infos, problems = analyse_joins(graph)
            for code, parts, addr, message in problems:
                self.report.error(code, parts, message)
            if key is not None:
                for parts, addr, message in open_body_forks(graph, infos):
                    self.report.error("COMPOSITION", parts, message)
            joins[key] = {}
            for addr, info in infos.items():
                branches = {info["names"][start]: {m[0] for m in members} for start, members in info["branches"].items()}
                fanout = {info["names"][start] for start in info["fanout"]}
                joins[key][addr[0]] = {"origin": info["origin"][0], "branches": branches, "fanout": fanout}
                if key is None:
                    self.report.joins[addr[0]] = {"origin": info["origin"][0], "branches": list(branches)}
        # Messages and instances are followed across compositions, on expanded graphs.
        in_branch = {
            key: {member for info in found.values() for members in info["branches"].values() for member in members}
            for key, found in joins.items()
        }
        graphs = []
        if None in scopes:
            graphs.append(Graph.for_flow(self.doc, in_branch, covered))
            # A join in a composition is reported once per use, by its step path.
            for use, (decl, child, _) in sorted(graphs[0].composes.items()):
                if child is None:
                    continue
                for name, info in joins.get(decl["composition"], {}).items():
                    self.report.joins["/".join(use + (name,))] = {
                        "origin": "/".join(use + (info["origin"],)),
                        "branches": list(info["branches"]),
                    }
        for name in self.compositions:
            if name in scopes:
                graphs.append(Graph.for_composition(self.doc, name, in_branch))
        for index, graph in enumerate(graphs):
            infos = {}
            for addr, node in graph.nodes.items():
                info = joins.get(node.scope.composition, {}).get(node.name) if node.type == "join" else None
                if info is not None:
                    infos[addr] = dict(info, prefix=node.scope.prefix)
            if index == 0 and None in scopes:
                self.record_uses(graph)
            self.record_choices(graph)
            self.check_selections(graph, infos)
            self.check_missions(graph)
            self.check_shared_instances(graph, infos)

    def record_uses(self, graph):
        for node in graph.nodes.values():
            if node.type == "agent" and node.agent in self.uses:
                usage = self.uses[node.agent]
                usage["new"] |= node.decl.get("instance") == "new"
                usage["steer"] |= node.decl.get("delivery") == "steer"

    def record_choices(self, graph):
        """Choices of agent steps, with composition parameters resolved."""
        for node in graph.nodes.values():
            if node.type != "agent" or node.agent not in self.uses:
                continue
            usage = self.uses[node.agent]
            usage["used"] = True
            nxt = node.decl.get("next")
            if isinstance(nxt, dict) and "step" not in nxt and "output" not in nxt:
                usage["choices"].update(nxt)

    def instructs(self, node):
        return node.type == "agent" and bool(self.agents.get(node.agent, {}).get("instructs"))

    def brings_prompt(self, graph, edge, incoming, seen):
        """Whether a route always delivers a prompt to its target, or None when
        that depends on an agent parameter not bound in this graph."""
        if edge.message is not None:
            return "prompt" in edge.message
        if edge.kind == "error":
            return False
        node = graph.nodes[edge.src]
        if node.type == "agent" and node.agent is None:
            return None
        if self.instructs(node):
            return True
        if node.type == "approval" and node.addr not in seen:
            arriving = incoming.get(node.addr, [])
            found = [self.brings_prompt(graph, e, incoming, seen | {node.addr}) for e in arriving]
            if None in found:
                return None
            return bool(arriving) and all(found)
        return False

    def check_missions(self, graph):
        incoming = {}
        for edge in graph.edges:
            incoming.setdefault(edge.dst, []).append(edge)
        for addr, edges in incoming.items():
            node = graph.nodes[addr]
            if node.type != "agent" or "prompt" in node.decl:
                continue
            brings = [self.brings_prompt(graph, e, incoming, frozenset()) for e in edges]
            if None in brings:
                # Checked in each use, where the parameter is bound.
                continue
            missing = [e for e, found in zip(edges, brings) if not found]
            if missing and len(missing) < len(edges):
                sources = ", ".join(sorted({graph.nodes[e.src].name for e in missing}))
                self.report.error("PROMPT", node.pointer, f"step '{node.name}' receives a prompt on some routes but not from {sources}; give it a default prompt", expanded(addr))

    def check_selections(self, graph, infos):
        self.check_instruction_fanouts(graph)
        reported = set()
        for edge in graph.edges:
            target = graph.nodes[edge.dst]
            if target.type == "call":
                # An operand reads the output of the step the route leaves.
                for name, operand in target.decl.get("arguments", {}).items():
                    if "path" not in operand:
                        continue
                    reason = self.selection_problem(graph, edge, operand["path"], infos, in_message=False)
                    at = target.pointer + ["arguments", name, "path"]
                    if reason and (tuple(at), reason) not in reported:
                        reported.add((tuple(at), reason))
                        self.report.error("MESSAGE_PATH", at, reason, expanded(edge.src))
            if edge.each is not None:
                reason = self.selection_problem(graph, edge, edge.each, infos, in_message=False) or self.fanout_problem(graph, edge, infos)
                if reason:
                    self.report.error("MESSAGE_PATH", edge.pointer + ["each"], reason, expanded(edge.src))
            message = edge.message
            if not message:
                continue
            prompt = message.get("prompt")
            if isinstance(prompt, dict) and "from" in prompt:
                path = prompt["from"]
                at = edge.pointer + ["message", "prompt", "from"]
                source = graph.nodes[edge.src]
                if edge.kind == "error" or not (
                    (source.type == "agent" and path == ["instructions"])
                    or (source.type == "join" and len(path) == 3 and path[0] == "branches" and path[2] == "instructions")
                    or (path == ["item"] and edge.each is not None and list(edge.each) == ["instructions"])
                ):
                    self.report.error("MESSAGE_PATH", at, "a prompt selects only the instructions of an agent or of a join branch, or an element of instructions in a fan-out", expanded(edge.src))
                else:
                    reason = self.selection_problem(graph, edge, path, infos)
                    if reason:
                        self.report.error("MESSAGE_PATH", at, reason, expanded(edge.src))
            for name, use in message.get("resources", {}).items():
                if "from" not in use:
                    continue
                reason = self.selection_problem(graph, edge, use["from"], infos)
                if reason:
                    self.report.error("MESSAGE_PATH", edge.pointer + ["message", "resources", name, "from"], reason, expanded(edge.src))

    def selection_problem(self, graph, edge, path, infos, in_message=True):
        """Why a selection path cannot be read on a route, or None. `item` is
        read only in a message: `each` itself reads the step's output."""
        if not path:
            return None
        head = path[0]
        if head == "item":
            # The element of a fan-out: read below the list the fan-out reads.
            if edge.each is None or not in_message:
                return "'item' exists only in the message of a fan-out"
            if list(edge.each) == ["instructions"]:
                return None if len(path) == 1 else "'item' is an instruction, a string"
            return self.selection_problem(graph, edge, list(edge.each) + [0] + list(path[1:]), infos, in_message=False)
        if edge.kind == "error":
            return self.error_path_problem(path)
        node = graph.nodes[edge.src]
        if node.type == "agent":
            agent = self.agents.get(node.agent)
            if agent is None:
                return None
            if head == "instructions":
                if not agent.get("instructs"):
                    return f"agent '{node.agent}' does not instruct"
                if edge.each is not None and list(edge.each) == ["instructions"]:
                    # A route that fans out over them receives a list of strings.
                    if len(path) > 1 and not valueschema.is_index(path[1]):
                        return "'instructions' is a list here: select one by its index"
                    return None if len(path) <= 2 else "an instruction is a string"
                return None if len(path) == 1 else "'instructions' is a string"
            if head in ("text", "choice"):
                if len(path) > 1:
                    return f"'{head}' is a string"
                nxt = node.decl.get("next")
                if head == "choice" and not (isinstance(nxt, dict) and "step" not in nxt and "output" not in nxt):
                    return f"step '{node.name}' does not route by choice"
                return None
            if head != "results":
                return f"an agent output has text, results, choice and instructions, not {head!r}"
            if len(path) == 1:
                return None
            results = agent.get("results", {})
            if path[1] not in results:
                return f"agent '{node.agent}' declares no result {path[1]!r}"
            result = results[path[1]]
            rest = path[2:]
            if not rest:
                return None
            if not is_json_media(result.get("mediaType", "application/json")):
                return f"result {path[1]!r} is not JSON and has no fields"
            if "schema" in result:
                ok, reason = valueschema.descend(result["schema"], rest)
                if ok is False:
                    return reason
            return None
        if node.type == "call":
            if head == "outcome":
                return None if len(path) == 1 else "'outcome' has no fields"
            if head != "data":
                return "a call output has only 'outcome' and 'data'"
            if "command" in node.decl and len(path) > 1:
                parse = node.decl.get("parse")
                if path[1] == "value":
                    if parse is None:
                        return f"step '{node.name}' declares no parse, so its result has no value"
                    if parse == "lines" and len(path) > 2:
                        if not valueschema.is_index(path[2]):
                            return "'value' is a list of lines: select a line by its index"
                        if len(path) > 3:
                            return "a line is a string"
                    return None
                if path[1] not in ("exitCode", "output"):
                    return f"a command result has exitCode, output and, with parse, value, not {path[1]!r}"
                if len(path) > 2:
                    return f"'{path[1]}' has no fields"
            return None
        if node.type == "approval":
            if head not in ("choice", "comment", "message"):
                return f"an approval output has choice, comment and message, not {head!r}"
            if head != "message":
                return f"'{head}' is a string" if len(path) > 1 else None
            if len(path) == 1:
                return None
            if path[1] not in ("prompt", "resources", "item", "comments"):
                return f"a message has prompt, resources, item and comments, not {path[1]!r}"
            if path[1] == "resources" and len(path) > 2:
                names = self.received_resources(graph, node.addr, infos, frozenset())
                if names is not None and path[2] not in names:
                    return f"approval '{node.name}' receives no resource {path[2]!r}"
            return None
        if node.type == "join":
            if head not in ("outcome", "branches"):
                return f"a join output has outcome and branches, not {head!r}"
            if head == "outcome" and len(path) > 1:
                return "'outcome' is a string"
            info = infos.get(node.addr)
            if head == "branches" and len(path) > 1 and info is not None:
                if path[1] not in info["branches"]:
                    return f"join '{node.name}' has no branch {path[1]!r}"
                rest = path[2:]
                if path[1] in info.get("fanout", ()) and rest:
                    # A fan-out branch is a list of entries, each with its item.
                    if not valueschema.is_index(rest[0]):
                        return f"branch {path[1]!r} is a fan-out: select an entry by its index"
                    rest = rest[1:]
                    if rest and rest[0] == "item":
                        return self.branch_item_problem(graph, node, info, path[1], rest, infos)
                if rest and rest[0] in ("ended", "by"):
                    return f"'{rest[0]}' is a string" if len(rest) > 1 else None
                if rest and rest[0] == "error":
                    if "quorum" not in node.decl and node.decl.get("failures") != "keep":
                        return 'only a quorum or failures: "keep" keeps a failed branch'
                    return self.error_path_problem(rest)
                if rest:
                    # The branch output is the output of the step that reached the join.
                    members = info["branches"][path[1]]
                    for producer in graph.edges:
                        if producer.dst != node.addr or producer.kind != "normal":
                            continue
                        local = scope_member(producer.src, info["prefix"])
                        direct = local == info["origin"] == path[1]
                        if local in members or direct:
                            reason = self.selection_problem(graph, producer, rest, infos)
                            if reason:
                                return f"branch {path[1]!r}: {reason}"
            return None
        return None

    def branch_item_problem(self, graph, join, info, branch, rest, infos):
        """Check a path below `item` in an entry of a fan-out branch: the
        element of the list that the origin fans out over."""
        for edge in graph.edges:
            if edge.each is None:
                continue
            if scope_member(edge.src, info["prefix"]) != info["origin"]:
                continue
            if scope_member(edge.dst, info["prefix"]) != branch:
                continue
            reason = self.selection_problem(graph, edge, rest, infos)
            if reason:
                return f"branch {branch!r}: {reason}"
        return None

    @staticmethod
    def error_path_problem(path):
        """Check a path in the input of an error route: code and message are
        strings, details a list of objects whose fields are not declared."""
        if path[0] != "error":
            return "an error route carries only 'error'"
        if len(path) == 1:
            return None
        field = path[1]
        if field not in ("code", "message", "details"):
            return f"an error has no field {field!r}"
        if field in ("code", "message"):
            return f"'{field}' is a string" if len(path) > 2 else None
        if len(path) > 2 and not valueschema.is_index(path[2]):
            return "'details' is a list: select an entry by its index"
        return None

    @staticmethod
    def fanout_max(edge):
        """The max of the authored fan-out target behind an edge."""
        return edge.fanout.get("max") if edge.fanout is not None else None

    def check_instruction_fanouts(self, graph):
        """A route that fans out over instructions makes them a list: none of its
        other targets can use them as one prompt."""
        routes = {}
        for edge in graph.edges:
            routes.setdefault((edge.src, edge.kind, edge.key), []).append(edge)
        for edges in routes.values():
            if not any(e.each is not None and list(e.each) == ["instructions"] for e in edges):
                continue
            for edge in edges:
                if edge.each is not None and list(edge.each) == ["instructions"]:
                    continue
                target = graph.nodes[edge.dst]
                if edge.message is None:
                    uses = target.type in ("agent", "approval")
                else:
                    uses = edge.message.get("prompt") == {"from": ["instructions"]}
                if uses:
                    self.report.error(
                        "MESSAGE_PATH",
                        edge.pointer,
                        f"this route fans out over the instructions of '{graph.nodes[edge.src].name}', so they are a list; '{target.name}' cannot receive them as one prompt",
                        expanded(edge.src),
                    )

    def fanout_problem(self, graph, edge, infos):
        """Whether the value a fan-out reads is declared as something other than a list."""
        if list(edge.each) == ["instructions"]:
            return None
        kind = self.declared_kind(graph, edge, edge.each, infos)
        if kind is not None and kind != "array":
            return f"a fan-out reads a list, and this value is declared as {article(kind)}"
        return None

    def received_resources(self, graph, addr, infos, seen):
        """The names of the resources a step can receive, or None when they
        are not all known: from the host, a parameter, or a loop of approvals."""
        if addr == graph.root:
            # The entry receives the host's message, which no document declares.
            return None
        names = set()
        for edge in graph.edges:
            if edge.dst != addr:
                continue
            if edge.message is not None:
                names |= set(edge.message.get("resources", {}))
                continue
            if edge.kind == "error":
                names.add("error")
                continue
            node = graph.nodes[edge.src]
            if node.type == "agent":
                agent = self.agents.get(node.agent)
                if agent is None:
                    return None
                names |= {"text"} | set(agent.get("results", {}))
            elif node.type == "call":
                names.add("result")
            elif node.type == "join" and node.addr in infos:
                names |= set(infos[node.addr]["branches"])
            elif node.type == "approval" and node.addr not in seen:
                found = self.received_resources(graph, node.addr, infos, seen | {addr})
                if found is None:
                    return None
                names |= found
            else:
                return None
        return names

    def declared_kind(self, graph, edge, path, infos):
        """The declared JSON type at a selection path, or None when it is not declared."""
        if not path:
            return "object"
        if edge.kind == "error":
            if path == ["error", "details"]:
                return "array"
            return "object" if len(path) == 1 else ("string" if len(path) == 2 else None)
        node = graph.nodes[edge.src]
        head = path[0]
        if node.type == "agent":
            if head in ("text", "choice", "instructions"):
                return "string"
            agent = self.agents.get(node.agent) or {}
            if len(path) == 1:
                return "object"
            result = agent.get("results", {}).get(path[1])
            if result is None:
                return None
            media = result.get("mediaType", "application/json")
            if not is_json_media(media):
                return "string"
            if "schema" not in result:
                return None
            return valueschema.kind_at(result["schema"], path[2:])
        if node.type == "call":
            if head == "outcome":
                return "string"
            if "command" in node.decl:
                if len(path) == 1:
                    return "object"
                if path[1] == "value" and node.decl.get("parse") == "lines":
                    return "array" if len(path) == 2 else "string"
                return {"exitCode": "integer", "output": "string"}.get(path[1])
            return None
        if node.type == "approval":
            if head != "message":
                return "string"
            if len(path) == 1 or path[1:] == ["resources"]:
                return "object"
            if path[1:] == ["comments"]:
                return "array"
            return None
        if node.type == "join":
            if head == "outcome":
                return "string"
            if len(path) == 1:
                return "object"
            info = infos.get(node.addr)
            if len(path) == 2 and info is not None:
                return "array" if path[1] in info.get("fanout", ()) else "object"
            return None
        return None

    def check_shared_instances(self, graph, infos):
        for addr, info in infos.items():
            seen = {}
            finishing = {}
            for start, members in info["branches"].items():
                for member in sorted(graph.nodes):
                    if scope_member(member, info["prefix"]) not in members:
                        continue
                    node = graph.nodes[member]
                    if node.type != "agent" or node.agent is None:
                        continue
                    instance = node.decl.get("instance")
                    if instance == "new":
                        continue
                    key = (node.agent, instance)
                    finishing.setdefault(key, start)
                    if "delivery" in node.decl:
                        continue
                    other = seen.get(key)
                    if other is not None and other[0] != start:
                        self.report.warning(
                            "SHARED_INSTANCE_PARALLEL",
                            node.pointer,
                            f"steps '{other[1]}' and '{node.name}' use the {instance_label(instance)} of agent '{node.agent}' in parallel branches; their work will be serialized",
                            expanded(member),
                        )
                    else:
                        seen.setdefault(key, (start, node.name))
            if graph.nodes[addr].decl.get("remaining") == "finish":
                self.check_after_finish(graph, addr, finishing)
        self.check_fanout_instances(graph, infos)
        self.check_open_fork_instances(graph, infos)

    def check_open_fork_instances(self, graph, infos):
        """Paths of a fork that meets no join run at the same time to their end."""
        origins = {(info["prefix"] + (info["origin"],)) for info in infos.values()}
        warned = set()
        succ = graph.successors()
        for addr in sorted(graph.nodes):
            if addr in origins:
                continue
            groups = {}
            for edge in succ[addr]:
                if edge.each is None:
                    groups.setdefault((edge.kind, edge.key), set()).add(edge.dst)
            for targets in groups.values():
                if len(targets) < 2:
                    continue
                users = {}
                for target in sorted(targets):
                    for member in sorted(graph.reachable(target)):
                        node = graph.nodes[member]
                        if node.type != "agent" or node.agent is None or member in warned:
                            continue
                        instance = node.decl.get("instance")
                        if instance == "new" or "delivery" in node.decl:
                            continue
                        key = (node.agent, instance)
                        other = users.get(key)
                        if other is not None and other[0] != target:
                            warned.add(member)
                            self.report.warning(
                                "SHARED_INSTANCE_PARALLEL",
                                node.pointer,
                                f"steps '{other[1]}' and '{node.name}' can use the {instance_label(instance)} of agent '{node.agent}' at the same time; their work will be serialized",
                                expanded(member),
                            )
                        else:
                            users.setdefault(key, (target, node.name))

    def check_fanout_instances(self, graph, infos):
        """A step in the paths of a fan-out runs once per element, at the same time."""
        warned = set()
        bounded = set()
        for edge in graph.edges:
            if edge.each is None:
                continue
            closing = {
                addr for addr, info in infos.items()
                if info["origin"] == scope_member(edge.src, info["prefix"])
                and scope_member(edge.dst, info["prefix"]) in info.get("fanout", ())
            }
            limit = self.fanout_max(edge)
            for member in sorted(graph.reachable(edge.dst, blocked=closing)):
                node = graph.nodes[member]
                visits = node.decl.get("maxVisits") if node.decl is not None else None
                if visits is not None and member not in bounded and (limit is None or visits < limit):
                    bounded.add(member)
                    reason = f"below the fan-out's max of {limit}" if limit is not None else "while the fan-out has no max"
                    self.report.warning(
                        "FANOUT_VISITS",
                        node.pointer + ["maxVisits"],
                        f"step '{node.name}' runs once per element of the fan-out from '{graph.nodes[edge.src].name}', and its maxVisits is {reason}; bound the step that fans out instead",
                        expanded(member),
                    )
                if member in warned or node.type != "agent" or node.agent is None:
                    continue
                instance = node.decl.get("instance")
                if instance == "new" or "delivery" in node.decl:
                    continue
                warned.add(member)
                self.report.warning(
                    "SHARED_INSTANCE_PARALLEL",
                    node.pointer,
                    f"step '{node.name}' uses the {instance_label(instance)} of agent '{node.agent}' in every path of the fan-out from '{graph.nodes[edge.src].name}'; their work will be serialized",
                    expanded(member),
                )

    def check_after_finish(self, graph, join, finishing):
        """Steps after a finish join wait for the branches still using their instance."""
        for later in sorted(graph.reachable(join) - {join}):
            node = graph.nodes[later]
            if node.type != "agent" or node.agent is None:
                continue
            instance = node.decl.get("instance")
            if instance == "new" or node.decl.get("delivery") == "queue":
                continue
            branch = finishing.get((node.agent, instance))
            if branch is None:
                continue
            self.report.warning(
                "SHARED_INSTANCE_PARALLEL",
                node.pointer,
                f"step '{node.name}' uses the {instance_label(instance)} of agent '{node.agent}', which branch '{branch}' of join '{graph.nodes[join].name}' may still use while it finishes; its work will wait",
                expanded(later),
            )

    # Harnesses ------------------------------------------------------------

    def check_harnesses(self):
        for name, agent in self.agents.items():
            parts = ["agents", name]
            module = self.modules.get(agent["harness"])
            if module is None:
                self.report.warning("HARNESS_UNVERIFIED", parts + ["harness"], f"no module for harness '{agent['harness']}': the agent is not verified")
                continue
            harness = module["name"]
            usage = self.uses[name]
            used = []
            if agent.get("resources"):
                used.append(("resources", parts + ["resources"]))
            model = agent.get("model", {})
            if "name" in model:
                used.append(("model.name", parts + ["model", "name"]))
            if "effort" in model:
                used.append(("model.effort", parts + ["model", "effort"]))
            if agent.get("skills"):
                used.append(("skills", parts + ["skills"]))
            if agent.get("mcpServers"):
                used.append(("mcpServers", parts + ["mcpServers"]))
            if agent.get("plan"):
                used.append(("plan", parts + ["plan"]))
            if "planFirst" in agent:
                used.append(("planFirst." + agent["planFirst"], parts + ["planFirst"]))
            permissions = agent.get("permissions")
            if isinstance(permissions, dict) and "reviewer" in permissions:
                used.append(("reviewer." + permissions["reviewer"], parts + ["permissions", "reviewer"]))
            if isinstance(permissions, dict) and permissions.get("directories"):
                used.append(("directories", parts + ["permissions", "directories"]))
            if usage["new"]:
                used.append(("instance.new", parts))
            if usage["steer"]:
                used.append(("delivery.steer", parts))
            for key, where in used:
                self.check_property(module, harness, key, where, agent)
            self.check_permissions(module, harness, agent, parts)
            if "harnessSettings" in agent:
                settings = module.get("settings")
                if settings is None:
                    self.report.error("HARNESS_SETTINGS", parts + ["harnessSettings"], f"module '{harness}' declares no settings")
                else:
                    for at, message in valueschema.validate(agent["harnessSettings"], settings, parts + ["harnessSettings"]):
                        self.report.error("HARNESS_SETTINGS", at, message)

    def check_property(self, module, harness, key, where, agent):
        entry = module["properties"].get(key, {"support": "absent"})
        support = entry["support"]
        note = f" {entry['note']}" if entry.get("note") else ""
        label = key.replace(".", " ")
        if support == "absent":
            self.report.error("HARNESS_UNSUPPORTED", where, f"{harness} does not support {label}.{note}")
            return
        if support == "approximate":
            self.report.warning("HARNESS_APPROXIMATE", where, f"{harness} approximates {label}.{note}")
        if "versions" in entry:
            self.report.warning("HARNESS_VERSION", where, f"{harness} supports {label} only for versions {entry['versions']}.")
        if key == "model.effort" and "values" in entry:
            effort = agent["model"]["effort"]
            if effort not in entry["values"]:
                accepted = ", ".join(entry["values"])
                self.report.error("HARNESS_VALUE", where, f"{harness} accepts {accepted}; got {effort!r}")

    def check_permissions(self, module, harness, agent, parts):
        where = parts + ["permissions"]
        enforcement = module["permissions"]
        permissions = agent.get("permissions")
        # A harness rule on its own tools does not stop a shell command.
        shell_open = not shell_denied(permissions) and enforcement.get("shell", {}).get("allow", "absent") != "absent"
        bypass = f"shell commands bypass {harness}'s rules for it; deny shell, or use a harness that enforces it with a sandbox"

        def enforced(action, level):
            if level == "absent":
                return False
            return not (shell_open and level == "harness" and action in ("read", "write", "network"))

        for action, effects in effects_in_use(permissions).items():
            if action == "mcp" and not agent.get("mcpServers"):
                continue
            for effect in ("deny", "ask"):
                if effect not in effects:
                    continue
                level = enforcement.get(action, {}).get(effect, "absent")
                if level == "absent":
                    self.report.error("HARNESS_UNSUPPORTED", where, f"{harness} cannot enforce {effect!r} for {action!r}")
                elif not enforced(action, level):
                    self.report.error("HARNESS_UNSUPPORTED", where, f"{harness} cannot enforce {effect!r} for {action!r}: {bypass}")
        preset, rules = normalize(permissions)
        if enforcement.get("shell", {}).get("match") == "prefix":
            for index, rule in enumerate(rules):
                if rule["action"] != "shell" or rule["effect"] == "allow" or covers_all(rule):
                    continue
                if not command_prefix(rule["match"]):
                    self.report.error(
                        "HARNESS_UNSUPPORTED", where + ["rules", index, "match"],
                        f"{harness} matches commands by their leading words only; write the words, then \" *\" for any arguments",
                    )
        if preset is not None and outside(permissions) == "deny":
            level = enforcement.get("read", {}).get("outside", "absent")
            if level == "absent":
                self.report.error("HARNESS_UNSUPPORTED", where, f"{harness} cannot deny reads outside the zone; set \"outside\": \"read\" or use another harness")
            elif not enforced("read", level):
                self.report.error("HARNESS_UNSUPPORTED", where, f"{harness} cannot deny reads outside the zone: {bypass}")
