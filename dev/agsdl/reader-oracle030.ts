// Test-only oracle for D15 2.c.2. It calls the vendored 0.3 reader, validator,
// schema checker, graph and permission exports, never a second implementation.
// Reports and snapshots cross JSON-lines as exact text so that member order,
// messages and number lexemes are compared byte for byte by the Rust driver.
import { createHash } from 'node:crypto';
// @ts-expect-error Historical scanner has no declaration file; its test-only contract is typed below.
import * as sharedScanner from '../../src/vendor/agsdl/shared/json.mjs';
import { loadHarnessModule, ModuleError, parse, readWithSpans, stringify, validateExact } from '../../src/vendor/agsdl/v0.4/reader.mjs';
import type { ExactObject, ExactValue, HarnessModule030, ReaderOptions030 } from '../../src/vendor/agsdl/v0.4/reader.mjs';
import { SchemaChecker } from '../../src/vendor/agsdl/v0.4/schemacheck.mjs';
import { Graph, analyse_joins, open_body_forks, addressParts, type JoinInfo } from '../../src/vendor/agsdl/v0.4/graph.mjs';
import * as permissions from '../../src/vendor/agsdl/v0.4/permissions.mjs';
import documentSchema from '../../src/vendor/agsdl/v0.3/schema/agsdl.schema.json';
import moduleSchema from '../../src/vendor/agsdl/v0.3/schema/harness-module.schema.json';

type Modules = { kind: 'pinned' } | { kind: 'map'; entries: { name: string; json: string; load: boolean }[] };
type SchemaRoot = 'document' | 'module' | 'valueSchema' | 'hostMessage';
type PermissionFn = 'normalize' | 'outside' | 'shell_denied' | 'effect_for' | 'effects_in_use' | 'covers_all' | 'glob' | 'command_prefix';
export type ReaderRequest030 =
  | { op: 'read'; hex: string; modules: Modules }
  | { op: 'validateExact'; document: string; mode: 'v030' | 'shared'; modules: Modules }
  | { op: 'loadModule'; hex: string }
  | { op: 'schema'; root: SchemaRoot; value: string }
  | { op: 'graph'; document: string }
  | { op: 'permissions'; fn: PermissionFn; permissions: string | null; action: string; subject: string; pattern: string; paths: boolean; command: boolean; rule: string }
  | { op: 'probe'; depth: number };

const shared = sharedScanner as { parse(bytes: Uint8Array): { tree: ExactValue; error?: Error } };
const encoder = new TextEncoder();
const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

// The roots Macro builds: the validator's two pinned roots, the module settings
// shape of check_module and the host message shape of hostCompilation.ts.
const roots: Record<SchemaRoot, SchemaChecker> = {
  document: new SchemaChecker(documentSchema),
  module: new SchemaChecker(moduleSchema),
  valueSchema: new SchemaChecker({ $ref: '#/$defs/valueSchema', $defs: documentSchema.$defs }),
  hostMessage: new SchemaChecker({ type: 'object', additionalProperties: false,
    properties: { prompt: { $ref: '#/$defs/instructions' }, resources: { $ref: '#/$defs/resources' } }, $defs: documentSchema.$defs }),
};

function tree(text: string): ExactValue {
  const parsed = parse(encoder.encode(text));
  if (parsed.error) throw parsed.error;
  return parsed.tree;
}

/** Thrown while the caller builds its map, before any reader call. */
class SetupError extends Error {}

function options(modules: Modules): ReaderOptions030 | undefined {
  if (modules.kind === 'pinned') return undefined;
  const map = new Map<string, HarnessModule030>();
  for (const entry of modules.entries) {
    try {
      map.set(entry.name, entry.load ? loadHarnessModule(encoder.encode(entry.json)) : tree(entry.json) as unknown as HarnessModule030);
    } catch (error) {
      throw new SetupError(error instanceof Error ? error.message : String(error));
    }
  }
  return { modules: map };
}

// `undefined` is not JSON; the snapshot spells every absent value as null.
const or = <T>(value: T | undefined) => value === undefined ? null : value;

function describeGraph(graph: Graph) {
  const [infos, problems] = analyse_joins(graph);
  return [
    or(graph.root),
    [...graph.nodes].map(([addr, node]) => [addr, node.type, node.name, node.pointer, node.agent, node.scope.composition, node.scope.prefix]),
    [...graph.composes].map(([addr, [decl, child, parent]]) => [addr, (decl as { composition: string }).composition,
      child === null ? null : [child.prefix, child.composition, child.compose, or((child as { composeName?: string }).composeName),
        child.parent === null ? null : child.parent.prefix, Object.entries(child.bindings)], parent.prefix]),
    graph.edges.map(edge => [edge.src, edge.dst, edge.kind, edge.key, edge.message as ExactValue, edge.pointer, edge.fanout as ExactValue]),
    [...graph.immediate_dominators()],
    [...infos].map(([addr, info]: [string, JoinInfo]) => [addr, info.origin, [...info.branches].map(([start, members]) => [start, [...members]]),
      [...info.names].map(([start, name]) => [start, or(name)]), [...info.fanout]]),
    problems,
    open_body_forks(graph, infos),
  ];
}

/** Graphs of a shape-valid document, built as the validator and compiler build them. */
function graphSnapshot(document: ExactObject): unknown {
  if (roots.document.check(document).length) return { inDomain: false };
  const has = (value: object, key: string) => Object.hasOwn(value, key);
  const graphs: [string, Graph][] = [];
  let covered: string[] | null = null;
  const flow = document.flow as ExactObject | undefined;
  if (flow && has(flow.steps as ExactObject, flow.entry as string)) {
    const scope = Graph.for_scope(document);
    const [initial] = analyse_joins(scope);
    const members = new Set<string>();
    for (const info of initial.values()) for (const found of info.branches.values()) for (const member of found) members.add(addressParts(member)[0]);
    const errorCovered = Graph.flow_error_covered(document, members);
    covered = [...errorCovered];
    graphs.push(['scope:flow', scope], ['scope:flow:covered', Graph.for_scope(document, null, errorCovered)],
      ['flow', Graph.for_flow(document, null, errorCovered)], ['flow:plain', Graph.for_flow(document)]);
  }
  for (const [name, composition] of Object.entries((document.compositions ?? {}) as Record<string, ExactObject>)) {
    if (!has(composition.steps as ExactObject, composition.entry as string)) continue;
    graphs.push([`scope:${name}`, Graph.for_scope(document, name)], [`composition:${name}`, Graph.for_composition(document, name)]);
  }
  return { inDomain: true, snapshot: stringify([covered, graphs.map(([label, graph]) => [label, describeGraph(graph)])] as unknown as ExactValue) };
}

function permission(request: Extract<ReaderRequest030, { op: 'permissions' }>): unknown {
  const value = (request.permissions === null ? null : tree(request.permissions)) as permissions.Permissions;
  const action = request.action as permissions.Action;
  switch (request.fn) {
    case 'normalize': {
      const [preset, rules] = permissions.normalize(value);
      return [preset, rules.map(rule => [rule.action, rule.effect, or(rule.match)])];
    }
    case 'outside': return permissions.outside(value);
    case 'shell_denied': return permissions.shell_denied(value);
    case 'effect_for': return permissions.effect_for(value, action, request.subject);
    case 'effects_in_use': return Object.entries(permissions.effects_in_use(value)).map(([name, effects]) => [name, [...effects]]);
    case 'covers_all': return permissions.covers_all(tree(request.rule) as unknown as permissions.PermissionRule);
    case 'glob': return permissions.glob_matches(request.pattern, request.subject, request.paths, request.command);
    case 'command_prefix': return permissions.command_prefix(request.pattern);
  }
}

/** A chain of approvals that the JS validator walks recursively. */
export function approvalChain030(depth: number): string {
  const steps: Record<string, unknown> = { s: { type: 'agent', agent: 'w', next: 'a0' } };
  for (let i = 0; i < depth; i++) steps[`a${i}`] = { type: 'approval', next: { ok: i + 1 < depth ? `a${i + 1}` : 't' } };
  steps[`a${depth - 1}`] = { type: 'approval', next: { ok: { step: 't', message: { resources: { r: { from: ['message', 'resources', 'zz'] } } } }, retry: 't' } };
  steps.t = { type: 'agent', agent: 'w' };
  return JSON.stringify({ contract: 'agsdl-0.3.0', id: 'chain', agents: { w: { harness: 'none', permissions: 'full' } }, flow: { entry: 's', steps } });
}

function evaluate(request: ReaderRequest030): unknown {
  switch (request.op) {
    case 'read': {
      const read = readWithSpans(fromHex(request.hex), options(request.modules));
      return { report: JSON.stringify(read.report), spans: [...read.spans].map(([pointer, span]) => [pointer, span.start, span.end]) };
    }
    case 'validateExact': {
      const parsed = request.mode === 'shared' ? shared.parse(encoder.encode(request.document)) : parse(encoder.encode(request.document));
      if (parsed.error) throw parsed.error;
      return { report: JSON.stringify(validateExact(parsed.tree, options(request.modules))) };
    }
    case 'loadModule': return { module: stringify(loadHarnessModule(fromHex(request.hex)) as unknown as ExactValue) };
    case 'schema': return { problems: roots[request.root].check(tree(request.value)) };
    case 'graph': return graphSnapshot(tree(request.document) as ExactObject);
    case 'permissions': return { result: permission(request) };
    case 'probe': {
      const document = approvalChain030(request.depth);
      const read = readWithSpans(encoder.encode(document), { modules: new Map() });
      return { depth: request.depth, report: JSON.stringify(read.report), documentSha256: createHash('sha256').update(document).digest('hex') };
    }
  }
}

export function evaluateReader030(request: ReaderRequest030): unknown {
  try {
    return { status: 'ok', output: evaluate(request) };
  } catch (error) {
    if (error instanceof SetupError) return { status: 'setupError', message: error.message };
    if (error instanceof ModuleError) return { status: 'moduleError', message: error.message };
    // Never turn JS stack exhaustion into a report or a match.
    if (error instanceof RangeError) return { status: 'resourceLimit', name: error.name, message: error.message };
    const name = error instanceof Error ? error.name : typeof error;
    return { status: 'exception', name, message: error instanceof Error ? error.message : String(error) };
  }
}
