/**
 * Browser port of AgSDL v0.3.0 tooling/agsdl/graph.py.
 * Upstream commit bd9f8a5b16923476fd20ac2650bd1729ee151917, Apache-2.0.
 * Modified for Macro: slash-separated addresses, Map/Set, exact quorum
 * comparison, and Python tuple ordering over address segments; no I/O.
 * See ./LICENSE and ../NOTICE.md.
 */
import { compareNumbers } from './values.mjs';

const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const address = (prefix, name) => prefix ? `${prefix}/${name}` : name;
export const addressParts = addr => addr === '' ? [] : addr.split('/');
const last = addr => addr === '' ? undefined : addr.slice(addr.lastIndexOf('/') + 1);
const intersection = (a, b) => new Set([...a].filter(value => b.has(value)));
const sameSet = (a, b) => a.size === b.size && [...a].every(value => b.has(value));
const groupKey = edge => JSON.stringify([edge.kind, edge.key]);

/** Python compares address tuples by segment, with shorter tuples first. */
export function compare_addresses(left, right) {
  const a = addressParts(left), b = addressParts(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

export class Scope {
  constructor(steps, pointer, prefix, composition = null, bindings = null, compose = null, parent = null) {
    Object.assign(this, { steps, pointer, prefix, composition, bindings: bindings ?? {}, compose, parent });
  }
}

export class Node {
  constructor(addr, decl, scope, name) {
    Object.assign(this, { addr, decl, scope, name });
    this.type = decl === null ? 'exit' : decl.type;
    this.pointer = decl === null ? [] : [...scope.pointer, name];
    this.agent = null;
    if (this.type === 'agent') {
      const ref = decl.agent;
      this.agent = typeof ref === 'string' ? ref : (own(scope.bindings, ref.parameter) ? scope.bindings[ref.parameter] : null);
    }
  }
}

export class Edge {
  constructor(src, dst, kind, key, message, pointer, fanout = null) {
    Object.assign(this, { src, dst, kind, key, message, pointer, fanout });
    this.each = fanout === null ? null : fanout.each;
  }
}

export function* route_items(route, pointer) {
  const items = Array.isArray(route) ? route : [route];
  for (const [index, item] of items.entries()) {
    const where = Array.isArray(route) ? [...pointer, index] : pointer;
    if (typeof item === 'string') yield ['step', item, null, where, null];
    else if (own(item, 'step')) yield ['step', item.step, item.message ?? null, where, own(item, 'each') ? item : null];
    else yield ['output', item.output, item.message ?? null, where, null];
  }
}

export function* route_targets(route, pointer) {
  for (const [kind, name, message, where] of route_items(route, pointer)) yield [kind, name, message, where];
}

export function* step_routes(decl, pointer) {
  if (own(decl, 'next')) {
    const next = decl.next;
    if (object(next) && !own(next, 'step') && !own(next, 'output')) {
      for (const [key, route] of Object.entries(next)) yield ['normal', key, route, [...pointer, 'next', key]];
    } else yield ['normal', null, next, [...pointer, 'next']];
  }
  if (own(decl, 'onError')) yield ['error', null, decl.onError, [...pointer, 'onError']];
}

export class Graph {
  constructor(document, in_branch = null, covered = null) {
    Object.assign(this, { document, in_branch: in_branch ?? new Map(), covered: covered ?? new Set() });
    this.compositions = document.compositions ?? {};
    this.nodes = new Map();
    this.composes = new Map();
    this.edges = [];
    this.root = null;
  }

  static for_flow(document, in_branch = null, covered = null) {
    const graph = new Graph(document, in_branch, covered);
    const flow = document.flow;
    const scope = new Scope(flow.steps, ['flow', 'steps'], '');
    graph._add_scope(scope, []);
    graph._connect();
    graph.root = graph.resolve(scope, flow.entry);
    return graph;
  }

  static flow_error_covered(document, branch_members = new Set()) {
    const flow = document.flow, steps = flow.steps;
    if (!own(flow, 'onError') || !own(steps, flow.entry)) return new Set();
    const targets = new Set([...route_targets(flow.onError, [])].filter(([kind]) => kind === 'step').map(([, name]) => name));
    const seen = new Set([flow.entry]), queue = [flow.entry], branches = new Set(branch_members);
    for (let i = 0; i < queue.length; i++) {
      for (const [, , route] of step_routes(steps[queue[i]], [])) {
        for (const [kind, name] of route_targets(route, [])) {
          if (kind === 'step' && own(steps, name) && !seen.has(name)) {
            seen.add(name);
            queue.push(name);
          }
        }
      }
    }
    return new Set([...seen].filter(name => !targets.has(name) && !branches.has(name) && !own(steps[name], 'onError')));
  }

  static for_scope(document, composition = null, covered = null) {
    const graph = new Graph(document, null, composition === null ? covered : null);
    const container = composition === null ? document.flow : graph.compositions[composition];
    const pointer = composition === null ? ['flow', 'steps'] : ['compositions', composition, 'steps'];
    const scope = new Scope(container.steps, pointer, '', composition);
    for (const [name, decl] of Object.entries(scope.steps)) graph.nodes.set(name, new Node(name, decl, scope, name));
    for (const node of [...graph.nodes.values()]) {
      for (const [kind, key, route, rpointer] of step_routes(node.decl, node.pointer)) {
        for (const [tkind, tname, message, where, each] of route_items(route, rpointer)) {
          const dst = graph._local_target(scope, tkind, tname);
          if (dst !== null) graph.edges.push(new Edge(node.addr, dst, kind, key, message, where, each));
        }
      }
    }
    for (const name of [...graph.covered].sort()) {
      for (const [tkind, tname, message, where, each] of route_items(container.onError, ['flow', 'onError'])) {
        const dst = graph._local_target(scope, tkind, tname);
        if (dst !== null) graph.edges.push(new Edge(name, dst, 'error', null, message, where, each));
      }
    }
    graph.root = graph.nodes.has(container.entry) ? container.entry : null;
    return graph;
  }

  _local_target(scope, kind, name) {
    if (kind === 'step') return this.nodes.has(name) ? name : null;
    if (scope.composition === null) return null;
    const addr = `#exit/${name}`;
    if (!this.nodes.has(addr)) this.nodes.set(addr, new Node(addr, null, scope, name));
    return addr;
  }

  static for_composition(document, name, in_branch = null) {
    const graph = new Graph(document, in_branch);
    const composition = graph.compositions[name];
    const scope = new Scope(composition.steps, ['compositions', name, 'steps'], `#${name}`, name);
    graph._add_scope(scope, [name]);
    graph._connect();
    graph.root = graph.resolve(scope, composition.entry);
    return graph;
  }

  _add_scope(scope, stack) {
    const active = new Set(stack);
    const frames = [{ scope, entries: Object.entries(scope.steps), index: 0, target: null }];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (frame.index === frame.entries.length) {
        if (frame.target !== null) active.delete(frame.target);
        frames.pop();
        continue;
      }
      scope = frame.scope;
      const [name, decl] = frame.entries[frame.index++];
      const addr = address(scope.prefix, name);
      if (decl.type !== 'compose') {
        this.nodes.set(addr, new Node(addr, decl, scope, name));
        continue;
      }
      const target = decl.composition;
      const composition = own(this.compositions, target) ? this.compositions[target] : null;
      if (composition === null || active.has(target)) {
        this.composes.set(addr, [decl, null, scope]);
        continue;
      }
      const bindings = Object.fromEntries(Object.entries(decl.agents ?? {}).map(([parameter, value]) =>
        [parameter, typeof value === 'string' ? value : (own(scope.bindings, value.parameter) ? scope.bindings[value.parameter] : null)]));
      const child = new Scope(composition.steps, ['compositions', target, 'steps'], addr, target, bindings, addr, scope);
      child.composeName = name || scope.prefix ? name.slice(name.lastIndexOf('/') + 1) : undefined;
      this.composes.set(addr, [decl, child, scope]);
      active.add(target);
      frames.push({ scope: child, entries: Object.entries(child.steps), index: 0, target });
    }
  }

  resolve(scope, name) {
    let addr = address(scope.prefix, name);
    while (this.composes.has(addr)) {
      const [decl, child] = this.composes.get(addr);
      if (child === null) return null;
      scope = child;
      addr = address(scope.prefix, this.compositions[decl.composition].entry);
    }
    return this.nodes.has(addr) ? addr : null;
  }

  _targets(scope, kind, name, message, pointer, fanout) {
    const found = [], pending = [[scope, kind, name, message, pointer, fanout]];
    while (pending.length) {
      [scope, kind, name, message, pointer, fanout] = pending.pop();
      if (kind === 'step') {
        const addr = this.resolve(scope, name);
        if (addr !== null) found.push([addr, message, pointer, fanout]);
        continue;
      }
      if (scope.compose === null) {
        if (scope.composition === null) continue;
        const addr = `#exit/${name}`;
        if (!this.nodes.has(addr)) this.nodes.set(addr, new Node(addr, null, scope, name));
        found.push([addr, message, pointer, fanout]);
        continue;
      }
      const [decl, , parent] = this.composes.get(scope.compose);
      const route = own(decl.next ?? {}, name) ? decl.next[name] : null;
      if (route === null) continue;
      const outer = [...parent.pointer, scope.composeName ?? last(scope.compose), 'next', name];
      const items = [...route_items(route, outer)];
      for (let i = items.length - 1; i >= 0; i--) pending.push([parent, ...items[i]]);
    }
    return found;
  }

  _inherited_error(scope, name) {
    while (scope.compose !== null) {
      if (this.in_branch.get(scope.composition)?.has(name)) return null;
      const [decl, , parent] = this.composes.get(scope.compose);
      if (own(decl, 'onError')) return [parent, decl.onError, [...parent.pointer, last(scope.compose), 'onError']];
      name = scope.composeName ?? last(scope.compose);
      scope = parent;
    }
    if (scope.composition === null && this.covered.has(name)) return [scope, this.document.flow.onError, ['flow', 'onError']];
    return null;
  }

  _connect() {
    for (const node of [...this.nodes.values()]) {
      if (node.decl === null) continue;
      const routes = [...step_routes(node.decl, node.pointer)];
      if (!own(node.decl, 'onError')) {
        const inherited = this._inherited_error(node.scope, node.name);
        if (inherited !== null) routes.push(['error', null, inherited[1], inherited[2], inherited[0]]);
      }
      for (const [kind, key, route, pointer, scope = node.scope] of routes) {
        for (const [tkind, tname, message, where, each] of route_items(route, pointer)) {
          for (const [dst, carried, at, fanout] of this._targets(scope, tkind, tname, message, where, each)) {
            this.edges.push(new Edge(node.addr, dst, kind, key, carried, at, fanout));
          }
        }
      }
    }
  }

  successors() {
    const result = new Map([...this.nodes.keys()].map(addr => [addr, []]));
    for (const edge of this.edges) result.get(edge.src).push(edge);
    return result;
  }

  predecessors() {
    const result = new Map([...this.nodes.keys()].map(addr => [addr, []]));
    for (const edge of this.edges) result.get(edge.dst).push(edge);
    return result;
  }

  reachable(start, blocked = new Set()) {
    const succ = this.successors(), seen = new Set([start]), queue = [start], stop = new Set(blocked);
    for (let i = 0; i < queue.length; i++) {
      for (const edge of succ.get(queue[i])) {
        if (stop.has(edge.dst) || seen.has(edge.dst)) continue;
        seen.add(edge.dst);
        queue.push(edge.dst);
      }
    }
    return seen;
  }

  reaching(target, blocked = new Set()) {
    const pred = this.predecessors(), seen = new Set(), queue = [target], stop = new Set(blocked);
    for (let i = 0; i < queue.length; i++) {
      for (const edge of pred.get(queue[i])) {
        if (stop.has(edge.src) || seen.has(edge.src) || edge.src === target) continue;
        seen.add(edge.src);
        queue.push(edge.src);
      }
    }
    return seen;
  }

  dominators() {
    if (this.root === null) return new Map();
    const reach = this.reachable(this.root), pred = this.predecessors();
    const dom = new Map([...reach].map(n => [n, new Set(reach)]));
    dom.set(this.root, new Set([this.root]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of reach) {
        if (n === this.root) continue;
        const incoming = pred.get(n).filter(edge => reach.has(edge.src)).map(edge => dom.get(edge.src));
        const next = incoming.length ? incoming.slice(1).reduce(intersection, new Set(incoming[0])) : new Set();
        next.add(n);
        if (!sameSet(next, dom.get(n))) {
          dom.set(n, next);
          changed = true;
        }
      }
    }
    return dom;
  }

  immediate_dominators() {
    const dom = this.dominators(), idom = new Map();
    for (const [n, ds] of dom) {
      const strict = [...ds].filter(d => d !== n);
      if (strict.length) idom.set(n, strict.reduce((best, d) => dom.get(d).size > dom.get(best).size ? d : best));
    }
    return idom;
  }
}

export function local_name(addr, prefix) {
  const parts = addressParts(addr), before = addressParts(prefix);
  if (parts.length > before.length && before.every((part, i) => parts[i] === part)) return parts[before.length];
  return parts.at(-1);
}

export function route_groups(graph, addr, succ) {
  const groups = new Map();
  for (const edge of succ.get(addr)) {
    const key = groupKey(edge);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge.dst);
  }
  return groups;
}

export function open_body_forks(graph, infos) {
  if (graph.root === null) return [];
  const succ = graph.successors(), problems = [];
  for (const addr of [...graph.reachable(graph.root)].sort(compare_addresses)) {
    const node = graph.nodes.get(addr);
    if (node.decl === null) continue;
    for (const [group, dsts] of route_groups(graph, addr, succ)) {
      const targets = new Set(dsts);
      const fans = succ.get(addr).some(edge => groupKey(edge) === group && edge.each !== null);
      if (targets.size < 2 && !fans) continue;
      if ([...infos.values()].some(info => info.origin === addr && [...targets].every(target => info.branches.has(target)))) continue;
      problems.push([node.pointer, addr, `the fork at '${node.name}' does not start the branches of one join; a composition leaves at most once`]);
      break;
    }
  }
  return problems;
}

export function join_origin(graph, join, idom, succ) {
  const first = idom.get(join), chain = [];
  let current = first;
  while (current != null) {
    chain.push(current);
    current = idom.get(current);
  }
  const dominators = new Set(chain);
  const fork = (step, fanout_only = false) => {
    const groups = new Map();
    for (const edge of succ.get(step)) {
      const key = groupKey(edge);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(edge);
    }
    for (const edges of groups.values()) {
      if (edges.some(edge => edge.each !== null && (dominators.has(edge.dst) || edge.dst === join))) return true;
      if (!fanout_only) {
        const reaching = new Set(edges.filter(edge => edge.dst === join || graph.reachable(edge.dst, new Set([step])).has(join)).map(edge => edge.dst));
        if (reaching.size >= 2) return true;
      }
    }
    return false;
  };
  if (fork(first)) return first;
  let closed = 0;
  for (const step of chain) {
    if (graph.nodes.get(step).type === 'join') closed++;
    else if (fork(step)) {
      if (closed === 0) return fork(step, true) ? step : first;
      closed--;
    }
  }
  return first;
}

export function analyse_joins(graph) {
  const infos = new Map(), problems = [];
  if (graph.root === null || ![...graph.nodes.values()].some(node => node.type === 'join')) {
    return [infos, problems];
  }
  const idom = graph.immediate_dominators(), succ = graph.successors(), pred = graph.predecessors();
  const reach = graph.reachable(graph.root), origins = new Map();
  for (const [addr, node] of graph.nodes) {
    if (node.type === 'join' && reach.has(addr) && idom.has(addr)) origins.set(addr, join_origin(graph, addr, idom, succ));
  }
  for (const [addr, origin] of origins) {
    const node = graph.nodes.get(addr), joins_to_j = graph.reaching(addr, new Set([origin])), starts = [];
    for (const dsts of route_groups(graph, origin, succ).values()) {
      for (const dst of dsts) if (!starts.includes(dst) && (dst === addr || joins_to_j.has(dst))) starts.push(dst);
    }
    const branches = new Map();
    for (const start of starts) branches.set(start, start === addr ? new Set() :
      intersection(graph.reachable(start, new Set([origin, addr])), new Set([...joins_to_j, start])));
    const names = new Map(starts.map(start => [start, local_name(start === addr ? origin : start, node.scope.prefix)]));
    const started = succ.get(origin).filter(edge => branches.has(edge.dst));
    const fanout = new Set(started.filter(edge => edge.each !== null).map(edge => edge.dst));
    infos.set(addr, { origin, branches, names, fanout });

    if (!fanout.size && ![...route_groups(graph, origin, succ).values()].some(dsts => new Set(dsts.filter(dst => branches.has(dst))).size >= 2)) {
      problems.push(['JOIN', node.pointer, addr, `no route of the origin '${last(origin)}' starts two branches or more at once`]);
    }
    for (const edge of started) {
      if (fanout.has(edge.dst) && edge.each === null) problems.push(['JOIN', edge.pointer, origin, `branch '${names.get(edge.dst)}' of join '${last(addr)}' is a fan-out on another route; start it with each on every route`]);
    }
    const listed = [...branches];
    for (let i = 0; i < listed.length; i++) {
      for (let j = 0; j < i; j++) {
        const shared = intersection(listed[i][1], listed[j][1]);
        if (shared.size) {
          const step = [...shared].sort(compare_addresses)[0];
          problems.push(['JOIN', graph.nodes.get(step).pointer, step, `step '${last(step)}' belongs to two branches of join '${last(addr)}'`]);
        }
      }
    }
    for (const [start, members] of branches) {
      for (const member of members) {
        for (const edge of pred.get(member)) {
          if (members.has(edge.src) || (edge.src === origin && member === start)) continue;
          problems.push(['JOIN', edge.pointer, edge.src, `a route from '${last(edge.src)}' enters branch '${names.get(start)}' of join '${last(addr)}' from outside`]);
        }
      }
    }
    const all_members = new Set([...branches.values()].flatMap(members => [...members]));
    for (const edge of pred.get(addr)) {
      if (edge.kind === 'normal' && (edge.src === origin || all_members.has(edge.src))) continue;
      problems.push(['JOIN', edge.pointer, edge.src, `join '${last(addr)}' receives a route from '${last(edge.src)}', which is not one of its branches`]);
    }
    for (const [start, members] of branches) {
      for (const member of members) {
        for (const [group, dsts] of route_groups(graph, member, succ)) {
          const inside = dsts.filter(dst => members.has(dst) || dst === addr);
          if (inside.length && inside.length < dsts.length) {
            problems.push(['JOIN', graph.nodes.get(member).pointer, member, `a route of '${last(member)}' starts targets inside and outside branch '${names.get(start)}' of join '${last(addr)}' at once`]);
            continue;
          }
          const fans = succ.get(member).some(edge => groupKey(edge) === group && edge.each !== null && inside.includes(edge.dst));
          if (new Set(inside).size < 2 && !fans) continue;
          const closers = new Set([...members].filter(k => origins.get(k) === member));
          const open_fork = inside.some(dst => dst === addr || graph.reachable(dst, new Set([...closers, origin])).has(addr));
          if (open_fork) problems.push(['JOIN', graph.nodes.get(member).pointer, member, `the fork at '${last(member)}' is not closed by its own join before join '${last(addr)}'`]);
        }
      }
    }
    const quorum = node.decl.quorum;
    if (quorum && !fanout.size && compareNumbers(quorum.count, starts.length) > 0) {
      problems.push(['JOIN', [...node.pointer, 'quorum', 'count'], addr, `count ${quorum.count.raw ?? quorum.count} exceeds the ${starts.length} branches of join '${last(addr)}'`]);
    }
  }
  return [infos, problems];
}
