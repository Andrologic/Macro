// Browser port of AgSDL 0.3.0 tooling/agsdl/validator.py.
// Copyright Andrologic. Licensed under Apache-2.0; see LICENSE and ../NOTICE.md.
// Upstream commit bd9f8a5b16923476fd20ac2650bd1729ee151917.
import { parse, stringify } from './json.mjs';
import { compareNumbers, equal, isObject } from './values.mjs';
import * as valueschema from './valueschema.mjs';
import { Graph, analyse_joins, open_body_forks, route_items, route_targets, step_routes, addressParts } from './graph.mjs';
import { command_prefix, covers_all, effect_for, effects_in_use, normalize, outside, shell_denied } from './permissions.mjs';
import { SchemaChecker, pointer } from './schemacheck.mjs';
import documentSchema from './schema/agsdl.schema.json' with { type: 'json' };
import moduleSchema from './schema/harness-module.schema.json' with { type: 'json' };

export const CONTRACT = 'agsdl-0.3.0';
const DOCUMENT_SCHEMA = new SchemaChecker(documentSchema);
const MODULE_SCHEMA = new SchemaChecker(moduleSchema);
const has = (value, key) => Object.hasOwn(value, key);
const get = (value, key, fallback = null) => value != null && typeof key === 'string' && has(value, key) ? value[key] : fallback;
const entries = (value) => Object.entries(value);
const keys = (value) => Object.keys(value);
const sameKeys = (value, expected) => keys(value).length === expected.size && keys(value).every((key) => expected.has(key));
const article = (word) => ('aeiou'.includes(word[0]) ? 'an ' : 'a ') + word;
const repr = (value) => typeof value === 'string' ? `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}'` : stringify(value);
const listRepr = (values) => `[${values.map(repr).join(', ')}]`;
const expanded = (addr) => { const parts = addressParts(addr); return parts.length < 2 || parts[0].startsWith('#') ? null : parts; };
const instance_label = (instance) => instance ? `instance '${instance}'` : 'shared instance';
const scope_member = (addr, prefix) => {
  const parts = addressParts(addr), scope = prefix ? addressParts(prefix) : [];
  return parts.length > scope.length && scope.every((part, index) => parts[index] === part) ? parts[scope.length] : null;
};
const is_json_media = (media) => media === 'application/json' || media.endsWith('+json');
const sortedAddresses = (values) => [...values].sort((a, b) => {
  const left = addressParts(a), right = addressParts(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return left.length - right.length;
});

export class ModuleError extends Error {
  constructor(message) { super(message); this.name = 'ModuleError'; }
}

// Separate schema roots are essential: module and document $refs differ.
export function check_module(module) {
  const problems = MODULE_SCHEMA.check(module);
  if (problems.length) {
    const [where, message] = problems[0];
    throw new ModuleError(`${where || '/'}: ${message}`);
  }
  if (has(module, 'settings')) {
    const shape = new SchemaChecker({ $ref: '#/$defs/valueSchema', $defs: documentSchema.$defs }).check(module.settings);
    const consistency = shape.length ? [] : valueschema.consistency(module.settings, ['settings']);
    if (shape.length || consistency.length) {
      const [where, message] = (shape.length ? shape : consistency)[0];
      throw new ModuleError(`settings ${where}: ${message}`);
    }
  }
  return module;
}

export class Report {
  constructor() { this.diagnostics = []; this.joins = Object.create(null); this._seen = new Set(); }
  add(severity, code, parts, message, step = null) {
    const where = Array.isArray(parts) ? pointer(parts) : parts;
    const base = [severity, code, where, message];
    const baseKey = JSON.stringify(base), key = JSON.stringify([...base, step ?? []]);
    if (this._seen.has(key) || (step === null && this._seen.has(baseKey))) return;
    this._seen.add(key); this._seen.add(baseKey);
    const item = { severity, code, path: where, message };
    if (step !== null) item.step = [...step];
    this.diagnostics.push(item);
  }
  error(code, parts, message, step = null) { this.add('error', code, parts, message, step); }
  warning(code, parts, message, step = null) { this.add('warning', code, parts, message, step); }
  get valid() { return !this.diagnostics.some((item) => item.severity === 'error'); }
  as_json() { return { contract: CONTRACT, valid: this.valid, diagnostics: this.diagnostics, joins: this.joins }; }
}

export function validate_bytes(bytes, modules) {
  const report = new Report();
  const parsed = parse(bytes);
  if (parsed.error) { report.error('PARSE', '', parsed.error.message); return report; }
  return validate_document(parsed.tree, modules, report);
}

export function validate_document(document, modules, report = new Report()) {
  const problems = DOCUMENT_SCHEMA.check(document);
  if (problems.length) {
    for (const [where, message] of problems) report.error('SHAPE', where, message);
    return report;
  }
  new Checker(document, modules, report).run();
  return report;
}

class Checker {
  constructor(document, modules, report) {
    this.doc = document; this.modules = modules; this.report = report;
    this.agents = document.agents;
    this.compositions = get(document, 'compositions', {});
    this.content = get(document, 'content', {});
    this.uses = new Map(keys(this.agents).map((name) => [name, { new: false, steer: false, choices: new Set(), used: false }]));
    this.cycle = false;
  }
  run() {
    const scopes = [];
    if (has(this.doc, 'flow')) scopes.push([this.doc.flow, ['flow'], null]);
    for (const [name, composition] of entries(this.compositions)) scopes.push([composition, ['compositions', name], name]);
    this.check_compositions();
    for (const [container, where, composition] of scopes) this.check_scope(container, where, composition);
    this.check_agents();
    if (!this.cycle) this.check_graphs();
    this.check_completion_choices();
    this.check_harnesses();
  }
  check_content_uses(uses, parts) {
    if (typeof uses === 'string') return;
    const items = Array.isArray(uses) ? uses.entries() : entries(uses);
    for (const [key, use] of items) {
      if (has(use, 'ref') && !has(this.content, use.ref)) this.report.error('REFERENCE', [...parts, key, 'ref'], `no content named '${use.ref}'`);
    }
  }
  check_message(message, parts) {
    if (has(message, 'prompt')) this.check_content_uses(message.prompt, [...parts, 'prompt']);
    if (has(message, 'resources')) this.check_content_uses(message.resources, [...parts, 'resources']);
  }
  check_compositions() {
    const uses = new Map();
    for (const [name, composition] of entries(this.compositions)) {
      const dependencies = []; uses.set(name, dependencies);
      for (const [stepName, step] of entries(composition.steps)) {
        if (step.type === 'compose') dependencies.push([step.composition, ['compositions', name, 'steps', stepName, 'composition']]);
      }
      const exported = new Set();
      for (const step of Object.values(composition.steps)) {
        for (const [, , route] of step_routes(step, [])) {
          for (const [kind, target] of route_targets(route, [])) if (kind === 'output') exported.add(target);
        }
      }
      for (const [index, output] of composition.outputs.entries()) {
        if (!exported.has(output)) this.report.error('COMPOSITION', ['compositions', name, 'outputs', index], `no route of composition '${name}' leaves through output '${output}'`);
      }
    }
    // Explicit DFS preserves Python's traversal order without a call-stack ceiling.
    const state = new Map();
    for (const name of uses.keys()) {
      if (state.has(name)) continue;
      state.set(name, 'active');
      const stack = [[name, 0]];
      while (stack.length) {
        const frame = stack[stack.length - 1], dependencies = uses.get(frame[0]);
        if (frame[1] === dependencies.length) { state.set(frame[0], 'done'); stack.pop(); continue; }
        const [target, where] = dependencies[frame[1]++];
        if (!uses.has(target)) continue;
        if (state.get(target) === 'active') {
          this.cycle = true;
          this.report.error('COMPOSITION', where, `composition '${target}' uses itself, directly or through other compositions`);
        } else if (!state.has(target)) { state.set(target, 'active'); stack.push([target, 0]); }
      }
    }
  }
  check_scope(container, where, composition) {
    const steps = container.steps;
    const parameters = new Set(composition !== null ? get(this.compositions[composition], 'parameters', []) : []);
    const outputs = new Set(composition !== null ? this.compositions[composition].outputs : []);
    const entry = container.entry;
    if (!has(steps, entry)) this.report.error('REFERENCE', [...where, 'entry'], `no step named '${entry}'`);
    else if (steps[entry].type === 'join') this.report.error('ROUTES', [...where, 'entry'], `the entry cannot be ${article(steps[entry].type)}`);
    for (const [name, step] of entries(steps)) this.check_step(name, step, [...where, 'steps', name], steps, parameters, outputs, composition);
    let roots = [];
    if (composition === null && has(container, 'onError')) {
      this.check_flow_error(container);
      roots = [...route_targets(container.onError, [])].filter(([kind]) => kind === 'step').map(([, target]) => target);
    }
    if (has(steps, entry)) this.check_reachability(entry, steps, [...where, 'steps'], roots);
  }
  check_agent_ref(ref, parts, parameters, composition) {
    if (typeof ref === 'string') {
      if (!has(this.agents, ref)) this.report.error('REFERENCE', parts, `no agent named '${ref}'`);
      return;
    }
    const name = ref.parameter;
    if (composition === null) this.report.error('REFERENCE', parts, 'agent parameters exist only inside compositions');
    else if (!parameters.has(name)) this.report.error('REFERENCE', parts, `composition '${composition}' has no parameter '${name}'`);
  }
  check_step(name, step, parts, steps, parameters, outputs, composition) {
    if (step.type === 'agent') {
      this.check_agent_ref(step.agent, [...parts, 'agent'], parameters, composition);
      if (has(step, 'prompt')) this.check_content_uses(step.prompt, [...parts, 'prompt']);
      if (step.instance === 'new' && has(step, 'delivery')) this.report.error('DELIVERY', [...parts, 'delivery'], 'a fresh instance is never working: delivery cannot be used with instance "new"');
      if (typeof step.agent === 'string' && has(this.agents, step.agent)) {
        const usage = this.uses.get(step.agent);
        usage.used = true; usage.new ||= step.instance === 'new'; usage.steer ||= step.delivery === 'steer';
      }
    } else if (step.type === 'call' && has(step, 'mcp')) {
      const server = step.mcp.server;
      if (!has(get(this.doc, 'mcpServers', {}), server)) this.report.error('REFERENCE', [...parts, 'mcp', 'server'], `no MCP server named '${server}'`);
    } else if (step.type === 'compose') this.check_compose(step, parts, parameters, composition);
    this.check_routes(step, parts, steps, outputs, composition);
  }
  check_compose(step, parts, parameters, composition) {
    const target = step.composition;
    if (!has(this.compositions, target)) { this.report.error('REFERENCE', [...parts, 'composition'], `no composition named '${target}'`); return; }
    const declared = this.compositions[target], expected = new Set(get(declared, 'parameters', [])), given = get(step, 'agents', {});
    for (const missing of [...expected].filter((key) => !has(given, key)).sort()) this.report.error('COMPOSITION', [...parts, 'agents'], `missing agent for parameter '${missing}'`);
    for (const extra of keys(given).filter((key) => !expected.has(key)).sort()) this.report.error('COMPOSITION', [...parts, 'agents', extra], `composition '${target}' has no parameter '${extra}'`);
    for (const [parameter, ref] of entries(given)) this.check_agent_ref(ref, [...parts, 'agents', parameter], parameters, composition);
    const outputs = new Set(declared.outputs);
    if (!sameKeys(step.next, outputs)) this.report.error('COMPOSITION', [...parts, 'next'], `routes must cover exactly the outputs ${listRepr([...outputs].sort())}`);
  }
  check_routes(step, parts, steps, outputs, composition) {
    const kind = step.type, next = get(step, 'next');
    const isMap = isObject(next) && !has(next, 'step') && !has(next, 'output');
    if (kind === 'call' && isMap) {
      if (!sameKeys(next, new Set(['passed', 'failed']))) this.report.error('ROUTES', [...parts, 'next'], 'a call routes with a route, or a map with exactly passed and failed');
    } else if (kind === 'approval') {
      if (next === null || (isObject(next) && keys(next).length === 0)) this.report.error('ROUTES', [...parts, 'next'], 'an approval offers at least one choice');
    } else if (kind === 'join' && (next !== null || has(step, 'quorum'))) {
      if (has(step, 'quorum')) {
        if (!isMap || !sameKeys(next, new Set(['reached', 'missed']))) this.report.error('ROUTES', [...parts, 'next'], 'a quorum join routes with exactly reached and missed');
      } else if (step.failures === 'keep') {
        if (isMap && !sameKeys(next, new Set(['done', 'incomplete']))) this.report.error('ROUTES', [...parts, 'next'], 'a join that keeps failures routes with a route, or a map with exactly done and incomplete');
      } else if (isMap && !sameKeys(next, new Set(['done']))) this.report.error('ROUTES', [...parts, 'next'], 'a join without quorum routes with a route, or a map with only done');
    }
    if (kind === 'join') {
      if (has(step, 'quorum') && (has(step, 'failures') || has(step, 'maxFailures'))) this.report.error('JOIN', [...parts, has(step, 'failures') ? 'failures' : 'maxFailures'], 'failures and maxFailures apply to all mode only; a quorum already keeps failed branches');
      else if (has(step, 'maxFailures') && step.failures !== 'keep') this.report.error('JOIN', [...parts, 'maxFailures'], 'maxFailures requires failures: "keep"');
    }
    if (kind === 'agent' && isMap && typeof step.agent === 'string' && has(this.agents, step.agent)) for (const choice of keys(next)) this.uses.get(step.agent).choices.add(choice);
    for (const [, , route, where] of step_routes(step, parts)) this.check_route(route, where, steps, outputs, composition);
  }
  check_route(route, where, steps, outputs, composition) {
    const items = Array.isArray(route) ? route : [route];
    for (const [index, item] of items.entries()) {
      if (!isObject(item) || has(item, 'each')) continue;
      const at = Array.isArray(route) ? [...where, index] : where;
      for (const key of ['concurrency', 'max']) if (has(item, key)) this.report.error('ROUTES', [...at, key], `${key} limits a fan-out; it requires each`);
    }
    const seen = new Set();
    for (const [kind, target, message, at, each] of route_items(route, where)) {
      const key = JSON.stringify([kind, target]);
      if (seen.has(key)) this.report.error('DUPLICATE', at, `'${target}' appears twice in this route`);
      seen.add(key);
      if (kind === 'step') {
        if (!has(steps, target)) this.report.error('REFERENCE', at, `no step named '${target}'`);
        else if (message !== null && ['call', 'join'].includes(steps[target].type)) this.report.error('ROUTES', [...at, 'message'], `${article(steps[target].type)} cannot receive a message`);
        else if (each !== null && ['call', 'join'].includes(steps[target].type)) this.report.error('ROUTES', [...at, 'each'], `${article(steps[target].type)} receives no message, so it cannot tell the elements of a fan-out apart`);
      } else {
        if (composition === null) this.report.error('ROUTES', at, 'outputs exist only inside compositions');
        else if (!outputs.has(target)) this.report.error('REFERENCE', at, `composition '${composition}' has no output '${target}'`);
        if (message !== null) this.report.error('ROUTES', [...at, 'message'], "put the message on the compose step's route, not on the output");
      }
      if (message !== null) this.check_message(message, [...at, 'message']);
    }
  }
  check_flow_error(flow) { this.check_route(flow.onError, ['flow', 'onError'], flow.steps, new Set(), null); }
  check_reachability(entry, steps, parts, roots = []) {
    const seen = new Set([entry, ...roots.filter((root) => has(steps, root))]), queue = [...seen];
    for (let index = 0; index < queue.length; index++) {
      for (const [, , route] of step_routes(steps[queue[index]], [])) {
        for (const [kind, target] of route_targets(route, [])) {
          if (kind === 'step' && has(steps, target) && !seen.has(target)) { seen.add(target); queue.push(target); }
        }
      }
    }
    const origin = roots.length ? "the entry or the flow's onError" : 'the entry';
    for (const name of keys(steps)) if (!seen.has(name)) this.report.error('UNREACHABLE', [...parts, name], `step '${name}' cannot be reached from ${origin}`);
  }
  check_agents() {
    const skills = get(this.doc, 'skills', {}), servers = get(this.doc, 'mcpServers', {});
    for (const [name, agent] of entries(this.agents)) {
      const parts = ['agents', name];
      if (has(agent, 'instructions')) this.check_content_uses(agent.instructions, [...parts, 'instructions']);
      if (has(agent, 'resources')) this.check_content_uses(agent.resources, [...parts, 'resources']);
      for (const [index, skill] of get(agent, 'skills', []).entries()) if (!has(skills, skill)) this.report.error('REFERENCE', [...parts, 'skills', index], `no skill named '${skill}'`);
      for (const [index, server] of get(agent, 'mcpServers', []).entries()) if (!has(servers, server)) this.report.error('REFERENCE', [...parts, 'mcpServers', index], `no MCP server named '${server}'`);
      for (const [resultName, result] of entries(get(agent, 'results', {}))) {
        const where = [...parts, 'results', resultName];
        if (resultName === 'text') this.report.error('RESULT_NAME', where, "a result cannot be named 'text'");
        const media = get(result, 'mediaType', 'application/json');
        if (has(result, 'schema')) {
          if (!is_json_media(media)) this.report.error('SCHEMA', [...where, 'schema'], `a schema needs a JSON media type, not ${media}`);
          for (const [at, message] of valueschema.consistency(result.schema, [...where, 'schema'])) this.report.error('SCHEMA', at, message);
        }
      }
      const permissions = get(agent, 'permissions');
      if (isObject(permissions) && permissions.preset === 'read-only') {
        for (const [path, access] of entries(get(permissions, 'directories', {}))) if (access === 'write') this.report.error('PERMISSIONS', [...parts, 'permissions', 'directories', path], 'read-only never writes; this directory asks for write');
      }
      const check = get(agent, 'completionCheck');
      if (check !== null && effect_for(permissions, 'shell', check.command) === 'deny') this.report.error('PERMISSIONS', [...parts, 'completionCheck', 'command'], "the agent's own permissions deny this command");
    }
  }
  check_completion_choices() {
    for (const [name, agent] of entries(this.agents)) {
      const check = get(agent, 'completionCheck'), usage = this.uses.get(name);
      if (check === null || !usage.used) continue;
      for (const [index, choice] of get(check, 'choices', []).entries()) if (!usage.choices.has(choice)) this.report.error('REFERENCE', ['agents', name, 'completionCheck', 'choices', index], `no step using agent '${name}' routes by choice '${choice}'`);
    }
  }
  check_graphs() {
    const scopes = new Map();
    let covered = new Set();
    if (has(this.doc, 'flow') && has(this.doc.flow.steps, this.doc.flow.entry)) {
      const [infos] = analyse_joins(Graph.for_scope(this.doc));
      const members = new Set();
      for (const info of infos.values()) for (const found of info.branches.values()) for (const member of found) members.add(addressParts(member)[0]);
      covered = Graph.flow_error_covered(this.doc, members);
      scopes.set(null, Graph.for_scope(this.doc, null, covered));
    }
    for (const [name, composition] of entries(this.compositions)) if (has(composition.steps, composition.entry)) scopes.set(name, Graph.for_scope(this.doc, name));
    // Infer joins locally: a compose declaration is one node in its parent scope.
    const joins = new Map();
    for (const [key, graph] of scopes) {
      const [infos, problems] = analyse_joins(graph);
      for (const [code, parts, , message] of problems) this.report.error(code, parts, message);
      if (key !== null) for (const [parts, , message] of open_body_forks(graph, infos)) this.report.error('COMPOSITION', parts, message);
      const local = new Map(); joins.set(key, local);
      for (const [addr, info] of infos) {
        const branches = new Map([...info.branches].map(([start, members]) => [info.names.get(start), new Set([...members].map((member) => addressParts(member)[0]))]));
        const fanout = new Set([...info.fanout].map((start) => info.names.get(start)));
        const name = addressParts(addr)[0], origin = addressParts(info.origin)[0];
        local.set(name, { origin, branches, fanout });
        if (key === null) this.report.joins[name] = { origin, branches: [...branches.keys()] };
      }
    }
    const inBranch = new Map();
    for (const [key, found] of joins) {
      const members = new Set();
      for (const info of found.values()) for (const branch of info.branches.values()) for (const member of branch) members.add(member);
      inBranch.set(key, members);
    }
    const graphs = [];
    if (scopes.has(null)) {
      graphs.push(Graph.for_flow(this.doc, inBranch, covered));
      for (const use of sortedAddresses(graphs[0].composes.keys())) {
        const [decl, child] = graphs[0].composes.get(use);
        if (child === null) continue;
        for (const [name, info] of joins.get(decl.composition) ?? []) this.report.joins[`${use}/${name}`] = { origin: `${use}/${info.origin}`, branches: [...info.branches.keys()] };
      }
    }
    for (const name of keys(this.compositions)) if (scopes.has(name)) graphs.push(Graph.for_composition(this.doc, name, inBranch));
    for (const [index, graph] of graphs.entries()) {
      const infos = new Map();
      for (const [addr, node] of graph.nodes) {
        const info = node.type === 'join' ? joins.get(node.scope.composition)?.get(node.name) : null;
        if (info != null) infos.set(addr, { ...info, prefix: node.scope.prefix });
      }
      if (index === 0 && scopes.has(null)) this.record_uses(graph);
      this.record_choices(graph);
      this.check_selections(graph, infos);
      this.check_missions(graph);
      this.check_shared_instances(graph, infos);
    }
  }
  record_uses(graph) {
    for (const node of graph.nodes.values()) {
      if (node.type === 'agent' && this.uses.has(node.agent)) {
        const usage = this.uses.get(node.agent);
        usage.new ||= node.decl.instance === 'new'; usage.steer ||= node.decl.delivery === 'steer';
      }
    }
  }
  record_choices(graph) {
    for (const node of graph.nodes.values()) {
      if (node.type !== 'agent' || !this.uses.has(node.agent)) continue;
      const usage = this.uses.get(node.agent), next = get(node.decl, 'next');
      usage.used = true;
      if (isObject(next) && !has(next, 'step') && !has(next, 'output')) for (const choice of keys(next)) usage.choices.add(choice);
    }
  }
  instructs(node) { return node.type === 'agent' && !!get(get(this.agents, node.agent, {}), 'instructs', false); }
  brings_prompt(graph, edge, incoming, seen) {
    if (edge.message !== null) return has(edge.message, 'prompt');
    if (edge.kind === 'error') return false;
    const node = graph.nodes.get(edge.src);
    if (node.type === 'agent' && node.agent === null) return null;
    if (this.instructs(node)) return true;
    if (node.type === 'approval' && !seen.has(node.addr)) {
      const arriving = incoming.get(node.addr) ?? [];
      const found = arriving.map((item) => this.brings_prompt(graph, item, incoming, new Set([...seen, node.addr])));
      if (found.includes(null)) return null;
      return arriving.length > 0 && found.every(Boolean);
    }
    return false;
  }
  check_missions(graph) {
    const incoming = new Map();
    for (const edge of graph.edges) { if (!incoming.has(edge.dst)) incoming.set(edge.dst, []); incoming.get(edge.dst).push(edge); }
    for (const [addr, edges] of incoming) {
      const node = graph.nodes.get(addr);
      if (node.type !== 'agent' || has(node.decl, 'prompt')) continue;
      const brings = edges.map((edge) => this.brings_prompt(graph, edge, incoming, new Set()));
      if (brings.includes(null)) continue;
      const missing = edges.filter((_, index) => !brings[index]);
      if (missing.length && missing.length < edges.length) {
        const sources = [...new Set(missing.map((edge) => graph.nodes.get(edge.src).name))].sort().join(', ');
        this.report.error('PROMPT', node.pointer, `step '${node.name}' receives a prompt on some routes but not from ${sources}; give it a default prompt`, expanded(addr));
      }
    }
  }
  check_selections(graph, infos) {
    this.check_instruction_fanouts(graph);
    const reported = new Set();
    for (const edge of graph.edges) {
      const target = graph.nodes.get(edge.dst);
      if (target.type === 'call') {
        for (const [name, operand] of entries(get(target.decl, 'arguments', {}))) {
          if (!has(operand, 'path')) continue;
          const reason = this.selection_problem(graph, edge, operand.path, infos, false);
          const at = [...target.pointer, 'arguments', name, 'path'], key = JSON.stringify([at, reason]);
          if (reason && !reported.has(key)) { reported.add(key); this.report.error('MESSAGE_PATH', at, reason, expanded(edge.src)); }
        }
      }
      if (edge.each !== null) {
        const reason = this.selection_problem(graph, edge, edge.each, infos, false) || this.fanout_problem(graph, edge, infos);
        if (reason) this.report.error('MESSAGE_PATH', [...edge.pointer, 'each'], reason, expanded(edge.src));
      }
      const message = edge.message;
      if (message === null) continue;
      const prompt = get(message, 'prompt');
      if (isObject(prompt) && has(prompt, 'from')) {
        const path = prompt.from, at = [...edge.pointer, 'message', 'prompt', 'from'], source = graph.nodes.get(edge.src);
        if (edge.kind === 'error' || !(
          (source.type === 'agent' && equal(path, ['instructions'])) ||
          (source.type === 'join' && path.length === 3 && path[0] === 'branches' && path[2] === 'instructions') ||
          (equal(path, ['item']) && edge.each !== null && equal(edge.each, ['instructions']))
        )) this.report.error('MESSAGE_PATH', at, 'a prompt selects only the instructions of an agent or of a join branch, or an element of instructions in a fan-out', expanded(edge.src));
        else {
          const reason = this.selection_problem(graph, edge, path, infos);
          if (reason) this.report.error('MESSAGE_PATH', at, reason, expanded(edge.src));
        }
      }
      for (const [name, use] of entries(get(message, 'resources', {}))) {
        if (!has(use, 'from')) continue;
        const reason = this.selection_problem(graph, edge, use.from, infos);
        if (reason) this.report.error('MESSAGE_PATH', [...edge.pointer, 'message', 'resources', name, 'from'], reason, expanded(edge.src));
      }
    }
  }
  selection_problem(graph, edge, path, infos, inMessage = true) {
    if (!path.length) return null;
    const head = path[0];
    if (head === 'item') {
      if (edge.each === null || !inMessage) return "'item' exists only in the message of a fan-out";
      if (equal(edge.each, ['instructions'])) return path.length === 1 ? null : "'item' is an instruction, a string";
      return this.selection_problem(graph, edge, [...edge.each, 0, ...path.slice(1)], infos, false);
    }
    if (edge.kind === 'error') return this.error_path_problem(path);
    const node = graph.nodes.get(edge.src);
    if (node.type === 'agent') {
      const agent = get(this.agents, node.agent);
      if (agent === null) return null;
      if (head === 'instructions') {
        if (!get(agent, 'instructs', false)) return `agent '${node.agent}' does not instruct`;
        if (edge.each !== null && equal(edge.each, ['instructions'])) {
          if (path.length > 1 && !valueschema.is_index(path[1])) return "'instructions' is a list here: select one by its index";
          return path.length <= 2 ? null : 'an instruction is a string';
        }
        return path.length === 1 ? null : "'instructions' is a string";
      }
      if (['text', 'choice'].includes(head)) {
        if (path.length > 1) return `'${head}' is a string`;
        const next = get(node.decl, 'next');
        if (head === 'choice' && !(isObject(next) && !has(next, 'step') && !has(next, 'output'))) return `step '${node.name}' does not route by choice`;
        return null;
      }
      if (head !== 'results') return `an agent output has text, results, choice and instructions, not ${repr(head)}`;
      if (path.length === 1) return null;
      const results = get(agent, 'results', {});
      if (typeof path[1] !== 'string' || !has(results, path[1])) return `agent '${node.agent}' declares no result ${repr(path[1])}`;
      const result = results[path[1]], rest = path.slice(2);
      if (!rest.length) return null;
      if (!is_json_media(get(result, 'mediaType', 'application/json'))) return `result ${repr(path[1])} is not JSON and has no fields`;
      if (has(result, 'schema')) { const [ok, reason] = valueschema.descend(result.schema, rest); if (ok === false) return reason; }
      return null;
    }
    if (node.type === 'call') {
      if (head === 'outcome') return path.length === 1 ? null : "'outcome' has no fields";
      if (head !== 'data') return "a call output has only 'outcome' and 'data'";
      if (has(node.decl, 'command') && path.length > 1) {
        const parseMode = get(node.decl, 'parse');
        if (path[1] === 'value') {
          if (parseMode === null) return `step '${node.name}' declares no parse, so its result has no value`;
          if (parseMode === 'lines' && path.length > 2) {
            if (!valueschema.is_index(path[2])) return "'value' is a list of lines: select a line by its index";
            if (path.length > 3) return 'a line is a string';
          }
          return null;
        }
        if (!['exitCode', 'output'].includes(path[1])) return `a command result has exitCode, output and, with parse, value, not ${repr(path[1])}`;
        if (path.length > 2) return `'${path[1]}' has no fields`;
      }
      return null;
    }
    if (node.type === 'approval') {
      if (!['choice', 'comment', 'message'].includes(head)) return `an approval output has choice, comment and message, not ${repr(head)}`;
      if (head !== 'message') return path.length > 1 ? `'${head}' is a string` : null;
      if (path.length === 1) return null;
      if (!['prompt', 'resources', 'item', 'comments'].includes(path[1])) return `a message has prompt, resources, item and comments, not ${repr(path[1])}`;
      if (path[1] === 'resources' && path.length > 2) {
        const names = this.received_resources(graph, node.addr, infos, new Set());
        if (names !== null && !names.has(path[2])) return `approval '${node.name}' receives no resource ${repr(path[2])}`;
      }
      return null;
    }
    if (node.type === 'join') {
      if (!['outcome', 'branches'].includes(head)) return `a join output has outcome and branches, not ${repr(head)}`;
      if (head === 'outcome' && path.length > 1) return "'outcome' is a string";
      const info = infos.get(node.addr);
      if (head === 'branches' && path.length > 1 && info != null) {
        if (!info.branches.has(path[1])) return `join '${node.name}' has no branch ${repr(path[1])}`;
        let rest = path.slice(2);
        if (info.fanout.has(path[1]) && rest.length) {
          if (!valueschema.is_index(rest[0])) return `branch ${repr(path[1])} is a fan-out: select an entry by its index`;
          rest = rest.slice(1);
          if (rest.length && rest[0] === 'item') return this.branch_item_problem(graph, node, info, path[1], rest, infos);
        }
        if (rest.length && ['ended', 'by'].includes(rest[0])) return rest.length > 1 ? `'${rest[0]}' is a string` : null;
        if (rest.length && rest[0] === 'error') {
          if (!has(node.decl, 'quorum') && node.decl.failures !== 'keep') return 'only a quorum or failures: "keep" keeps a failed branch';
          return this.error_path_problem(rest);
        }
        if (rest.length) {
          const members = info.branches.get(path[1]);
          for (const producer of graph.edges) {
            if (producer.dst !== node.addr || producer.kind !== 'normal') continue;
            const local = scope_member(producer.src, info.prefix), direct = local === info.origin && info.origin === path[1];
            if (members.has(local) || direct) {
              const reason = this.selection_problem(graph, producer, rest, infos);
              if (reason) return `branch ${repr(path[1])}: ${reason}`;
            }
          }
        }
      }
      return null;
    }
    return null;
  }
  branch_item_problem(graph, join, info, branch, rest, infos) {
    for (const edge of graph.edges) {
      if (edge.each === null || scope_member(edge.src, info.prefix) !== info.origin || scope_member(edge.dst, info.prefix) !== branch) continue;
      const reason = this.selection_problem(graph, edge, rest, infos);
      if (reason) return `branch ${repr(branch)}: ${reason}`;
    }
    return null;
  }
  error_path_problem(path) {
    if (path[0] !== 'error') return "an error route carries only 'error'";
    if (path.length === 1) return null;
    const field = path[1];
    if (!['code', 'message', 'details'].includes(field)) return `an error has no field ${repr(field)}`;
    if (['code', 'message'].includes(field)) return path.length > 2 ? `'${field}' is a string` : null;
    if (path.length > 2 && !valueschema.is_index(path[2])) return "'details' is a list: select an entry by its index";
    return null;
  }
  fanout_max(edge) { return edge.fanout !== null ? get(edge.fanout, 'max') : null; }
  check_instruction_fanouts(graph) {
    const routes = new Map();
    for (const edge of graph.edges) {
      const key = JSON.stringify([edge.src, edge.kind, edge.key]);
      if (!routes.has(key)) routes.set(key, []);
      routes.get(key).push(edge);
    }
    for (const edges of routes.values()) {
      if (!edges.some((edge) => edge.each !== null && equal(edge.each, ['instructions']))) continue;
      for (const edge of edges) {
        if (edge.each !== null && equal(edge.each, ['instructions'])) continue;
        const target = graph.nodes.get(edge.dst);
        const uses = edge.message === null ? ['agent', 'approval'].includes(target.type) : equal(get(edge.message, 'prompt'), { from: ['instructions'] });
        if (uses) this.report.error('MESSAGE_PATH', edge.pointer, `this route fans out over the instructions of '${graph.nodes.get(edge.src).name}', so they are a list; '${target.name}' cannot receive them as one prompt`, expanded(edge.src));
      }
    }
  }
  fanout_problem(graph, edge, infos) {
    if (equal(edge.each, ['instructions'])) return null;
    const kind = this.declared_kind(graph, edge, edge.each, infos);
    return kind !== null && kind !== 'array' ? `a fan-out reads a list, and this value is declared as ${article(kind)}` : null;
  }
  received_resources(graph, addr, infos, seen) {
    if (addr === graph.root) return null;
    const names = new Set();
    for (const edge of graph.edges) {
      if (edge.dst !== addr) continue;
      if (edge.message !== null) { for (const name of keys(get(edge.message, 'resources', {}))) names.add(name); continue; }
      if (edge.kind === 'error') { names.add('error'); continue; }
      const node = graph.nodes.get(edge.src);
      if (node.type === 'agent') {
        const agent = get(this.agents, node.agent);
        if (agent === null) return null;
        names.add('text'); for (const name of keys(get(agent, 'results', {}))) names.add(name);
      } else if (node.type === 'call') names.add('result');
      else if (node.type === 'join' && infos.has(node.addr)) for (const name of infos.get(node.addr).branches.keys()) names.add(name);
      else if (node.type === 'approval' && !seen.has(node.addr)) {
        const found = this.received_resources(graph, node.addr, infos, new Set([...seen, addr]));
        if (found === null) return null;
        for (const name of found) names.add(name);
      } else return null;
    }
    return names;
  }
  declared_kind(graph, edge, path, infos) {
    if (!path.length) return 'object';
    if (edge.kind === 'error') {
      if (equal(path, ['error', 'details'])) return 'array';
      return path.length === 1 ? 'object' : path.length === 2 ? 'string' : null;
    }
    const node = graph.nodes.get(edge.src), head = path[0];
    if (node.type === 'agent') {
      if (['text', 'choice', 'instructions'].includes(head)) return 'string';
      const agent = get(this.agents, node.agent, {});
      if (path.length === 1) return 'object';
      const result = typeof path[1] === 'string' ? get(get(agent, 'results', {}), path[1]) : null;
      if (result === null) return null;
      if (!is_json_media(get(result, 'mediaType', 'application/json'))) return 'string';
      return has(result, 'schema') ? valueschema.kind_at(result.schema, path.slice(2)) : null;
    }
    if (node.type === 'call') {
      if (head === 'outcome') return 'string';
      if (has(node.decl, 'command')) {
        if (path.length === 1) return 'object';
        if (path[1] === 'value' && node.decl.parse === 'lines') return path.length === 2 ? 'array' : 'string';
        return get({ exitCode: 'integer', output: 'string' }, path[1]);
      }
      return null;
    }
    if (node.type === 'approval') {
      if (head !== 'message') return 'string';
      if (path.length === 1 || equal(path.slice(1), ['resources'])) return 'object';
      if (equal(path.slice(1), ['comments'])) return 'array';
      return null;
    }
    if (node.type === 'join') {
      if (head === 'outcome') return 'string';
      if (path.length === 1) return 'object';
      const info = infos.get(node.addr);
      if (path.length === 2 && info != null) return info.fanout.has(path[1]) ? 'array' : 'object';
    }
    return null;
  }
  check_shared_instances(graph, infos) {
    for (const [addr, info] of infos) {
      const seen = new Map(), finishing = new Map();
      for (const [start, members] of info.branches) {
        for (const member of sortedAddresses(graph.nodes.keys())) {
          if (!members.has(scope_member(member, info.prefix))) continue;
          const node = graph.nodes.get(member);
          if (node.type !== 'agent' || node.agent === null) continue;
          const instance = get(node.decl, 'instance');
          if (instance === 'new') continue;
          const key = JSON.stringify([node.agent, instance]);
          if (!finishing.has(key)) finishing.set(key, start);
          if (has(node.decl, 'delivery')) continue;
          const other = seen.get(key);
          if (other != null && other[0] !== start) this.report.warning('SHARED_INSTANCE_PARALLEL', node.pointer, `steps '${other[1]}' and '${node.name}' use the ${instance_label(instance)} of agent '${node.agent}' in parallel branches; their work will be serialized`, expanded(member));
          else if (!seen.has(key)) seen.set(key, [start, node.name]);
        }
      }
      if (graph.nodes.get(addr).decl.remaining === 'finish') this.check_after_finish(graph, addr, finishing);
    }
    this.check_fanout_instances(graph, infos);
    this.check_open_fork_instances(graph, infos);
  }
  check_open_fork_instances(graph, infos) {
    const origins = new Set([...infos.values()].map((info) => info.prefix ? `${info.prefix}/${info.origin}` : info.origin));
    const warned = new Set(), succ = graph.successors();
    for (const addr of sortedAddresses(graph.nodes.keys())) {
      if (origins.has(addr)) continue;
      const groups = new Map();
      for (const edge of succ.get(addr)) {
        if (edge.each !== null) continue;
        const key = JSON.stringify([edge.kind, edge.key]);
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key).add(edge.dst);
      }
      for (const targets of groups.values()) {
        if (targets.size < 2) continue;
        const users = new Map();
        for (const target of sortedAddresses(targets)) {
          for (const member of sortedAddresses(graph.reachable(target))) {
            const node = graph.nodes.get(member);
            if (node.type !== 'agent' || node.agent === null || warned.has(member)) continue;
            const instance = get(node.decl, 'instance');
            if (instance === 'new' || has(node.decl, 'delivery')) continue;
            const key = JSON.stringify([node.agent, instance]), other = users.get(key);
            if (other != null && other[0] !== target) {
              warned.add(member);
              this.report.warning('SHARED_INSTANCE_PARALLEL', node.pointer, `steps '${other[1]}' and '${node.name}' can use the ${instance_label(instance)} of agent '${node.agent}' at the same time; their work will be serialized`, expanded(member));
            } else if (!users.has(key)) users.set(key, [target, node.name]);
          }
        }
      }
    }
  }
  check_fanout_instances(graph, infos) {
    const warned = new Set(), bounded = new Set();
    for (const edge of graph.edges) {
      if (edge.each === null) continue;
      const closing = new Set([...infos].filter(([, info]) => info.origin === scope_member(edge.src, info.prefix) && info.fanout.has(scope_member(edge.dst, info.prefix))).map(([addr]) => addr));
      const limit = this.fanout_max(edge);
      for (const member of sortedAddresses(graph.reachable(edge.dst, closing))) {
        const node = graph.nodes.get(member), visits = get(node.decl, 'maxVisits');
        if (visits !== null && !bounded.has(member) && (limit === null || compareNumbers(visits, limit) < 0)) {
          bounded.add(member);
          const reason = limit !== null ? `below the fan-out's max of ${stringify(limit)}` : 'while the fan-out has no max';
          this.report.warning('FANOUT_VISITS', [...node.pointer, 'maxVisits'], `step '${node.name}' runs once per element of the fan-out from '${graph.nodes.get(edge.src).name}', and its maxVisits is ${reason}; bound the step that fans out instead`, expanded(member));
        }
        if (warned.has(member) || node.type !== 'agent' || node.agent === null) continue;
        const instance = get(node.decl, 'instance');
        if (instance === 'new' || has(node.decl, 'delivery')) continue;
        warned.add(member);
        this.report.warning('SHARED_INSTANCE_PARALLEL', node.pointer, `step '${node.name}' uses the ${instance_label(instance)} of agent '${node.agent}' in every path of the fan-out from '${graph.nodes.get(edge.src).name}'; their work will be serialized`, expanded(member));
      }
    }
  }
  check_after_finish(graph, join, finishing) {
    for (const later of sortedAddresses(graph.reachable(join))) {
      if (later === join) continue;
      const node = graph.nodes.get(later);
      if (node.type !== 'agent' || node.agent === null) continue;
      const instance = get(node.decl, 'instance');
      if (instance === 'new' || node.decl.delivery === 'queue') continue;
      const branch = finishing.get(JSON.stringify([node.agent, instance]));
      if (branch == null) continue;
      this.report.warning('SHARED_INSTANCE_PARALLEL', node.pointer, `step '${node.name}' uses the ${instance_label(instance)} of agent '${node.agent}', which branch '${branch}' of join '${graph.nodes.get(join).name}' may still use while it finishes; its work will wait`, expanded(later));
    }
  }
  check_harnesses() {
    for (const [name, agent] of entries(this.agents)) {
      const parts = ['agents', name], module = this.modules.get(agent.harness);
      if (module == null) { this.report.warning('HARNESS_UNVERIFIED', [...parts, 'harness'], `no module for harness '${agent.harness}': the agent is not verified`); continue; }
      const harness = module.name, usage = this.uses.get(name), used = [];
      if (keys(get(agent, 'resources', {})).length) used.push(['resources', [...parts, 'resources']]);
      const model = get(agent, 'model', {});
      if (has(model, 'name')) used.push(['model.name', [...parts, 'model', 'name']]);
      if (has(model, 'effort')) used.push(['model.effort', [...parts, 'model', 'effort']]);
      if (get(agent, 'skills', []).length) used.push(['skills', [...parts, 'skills']]);
      if (get(agent, 'mcpServers', []).length) used.push(['mcpServers', [...parts, 'mcpServers']]);
      if (get(agent, 'plan', false)) used.push(['plan', [...parts, 'plan']]);
      if (has(agent, 'planFirst')) used.push([`planFirst.${agent.planFirst}`, [...parts, 'planFirst']]);
      const permissions = get(agent, 'permissions');
      if (isObject(permissions) && has(permissions, 'reviewer')) used.push([`reviewer.${permissions.reviewer}`, [...parts, 'permissions', 'reviewer']]);
      if (isObject(permissions) && keys(get(permissions, 'directories', {})).length) used.push(['directories', [...parts, 'permissions', 'directories']]);
      if (usage.new) used.push(['instance.new', parts]);
      if (usage.steer) used.push(['delivery.steer', parts]);
      for (const [key, where] of used) this.check_property(module, harness, key, where, agent);
      this.check_permissions(module, harness, agent, parts);
      if (has(agent, 'harnessSettings')) {
        const settings = get(module, 'settings');
        if (settings === null) this.report.error('HARNESS_SETTINGS', [...parts, 'harnessSettings'], `module '${harness}' declares no settings`);
        else for (const [at, message] of valueschema.validate(agent.harnessSettings, settings, [...parts, 'harnessSettings'])) this.report.error('HARNESS_SETTINGS', at, message);
      }
    }
  }
  check_property(module, harness, key, where, agent) {
    const entry = get(module.properties, key, { support: 'absent' }), support = entry.support;
    const note = get(entry, 'note', '') ? ` ${entry.note}` : '', label = key.replaceAll('.', ' ');
    if (support === 'absent') { this.report.error('HARNESS_UNSUPPORTED', where, `${harness} does not support ${label}.${note}`); return; }
    if (support === 'approximate') this.report.warning('HARNESS_APPROXIMATE', where, `${harness} approximates ${label}.${note}`);
    if (has(entry, 'versions')) this.report.warning('HARNESS_VERSION', where, `${harness} supports ${label} only for versions ${entry.versions}.`);
    if (key === 'model.effort' && has(entry, 'values')) {
      const effort = agent.model.effort;
      if (!entry.values.includes(effort)) this.report.error('HARNESS_VALUE', where, `${harness} accepts ${entry.values.join(', ')}; got ${repr(effort)}`);
    }
  }
  check_permissions(module, harness, agent, parts) {
    const where = [...parts, 'permissions'], enforcement = module.permissions, permissions = get(agent, 'permissions');
    const shellOpen = !shell_denied(permissions) && get(get(enforcement, 'shell', {}), 'allow', 'absent') !== 'absent';
    const bypass = `shell commands bypass ${harness}'s rules for it; deny shell, or use a harness that enforces it with a sandbox`;
    const enforced = (action, level) => level !== 'absent' && !(shellOpen && level === 'harness' && ['read', 'write', 'network'].includes(action));
    for (const [action, effects] of entries(effects_in_use(permissions))) {
      if (action === 'mcp' && !get(agent, 'mcpServers', []).length) continue;
      for (const effect of ['deny', 'ask']) {
        if (!effects.has(effect)) continue;
        const level = get(get(enforcement, action, {}), effect, 'absent');
        if (level === 'absent') this.report.error('HARNESS_UNSUPPORTED', where, `${harness} cannot enforce ${repr(effect)} for ${repr(action)}`);
        else if (!enforced(action, level)) this.report.error('HARNESS_UNSUPPORTED', where, `${harness} cannot enforce ${repr(effect)} for ${repr(action)}: ${bypass}`);
      }
    }
    const [preset, rules] = normalize(permissions);
    if (get(get(enforcement, 'shell', {}), 'match') === 'prefix') {
      for (const [index, rule] of rules.entries()) {
        if (rule.action !== 'shell' || rule.effect === 'allow' || covers_all(rule)) continue;
        if (!command_prefix(rule.match)) this.report.error('HARNESS_UNSUPPORTED', [...where, 'rules', index, 'match'], `${harness} matches commands by their leading words only; write the words, then " *" for any arguments`);
      }
    }
    if (preset !== null && outside(permissions) === 'deny') {
      const level = get(get(enforcement, 'read', {}), 'outside', 'absent');
      if (level === 'absent') this.report.error('HARNESS_UNSUPPORTED', where, `${harness} cannot deny reads outside the zone; set "outside": "read" or use another harness`);
      else if (!enforced('read', level)) this.report.error('HARNESS_UNSUPPORTED', where, `${harness} cannot deny reads outside the zone: ${bypass}`);
    }
  }
}
