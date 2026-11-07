import { describe, expect, test } from 'bun:test';
import { Graph, Scope, Node, Edge, addressParts, compare_addresses, local_name, route_items, route_targets, step_routes, route_groups, analyse_joins, open_body_forks } from './graph.mjs';
import { NumberToken } from './json.mjs';

const agent = (next?: unknown) => ({ type: 'agent', agent: 'worker', ...(next === undefined ? {} : { next }) });
const flow = (steps: Record<string, Record<string, unknown>>, entry = 'start') => ({ flow: { entry, steps } });
const diamond = () => flow({ start: agent(['left', 'right']), left: agent('join'), right: agent('join'), join: { type: 'join' } });
const codes = (g: Graph) => analyse_joins(g)[1].map(p => p[3]);

describe('AgSDL 0.3 graphs', () => {
  test('route helpers preserve pointers, messages, choices and fanout declarations', () => {
    const fan = { step: 'b', each: ['data'], message: { prompt: { value: 'x' } } };
    expect([...route_items(['a', fan, { output: 'ok' }], ['next'])]).toEqual([
      ['step', 'a', null, ['next', 0], null], ['step', 'b', fan.message, ['next', 1], fan], ['output', 'ok', null, ['next', 2], null],
    ]);
    expect([...route_targets('a', [])]).toEqual([['step', 'a', null, []]]);
    expect([...step_routes({ next: { passed: 'a', failed: [] }, onError: 'b' }, ['s'])]).toEqual([
      ['normal', 'passed', 'a', ['s', 'next', 'passed']], ['normal', 'failed', [], ['s', 'next', 'failed']], ['error', null, 'b', ['s', 'onError']],
    ]);
  });
  test('addresses follow tuple segment ordering, and prefixes use segment boundaries', () => {
    expect(['a/z', 'a-b', 'a'].sort(compare_addresses)).toEqual(['a', 'a/z', 'a-b']);
    expect(addressParts('')).toEqual([]);
    expect(local_name('outer/inner/work', 'outer')).toBe('inner');
    expect(local_name('outerish/work', 'outer')).toBe('work');
  });
  test('dominance and blocked traversal retain loops and ignore unreachable nodes', () => {
    const d = diamond(); d.flow.steps.left.next = ['left', 'join']; d.flow.steps.lost = agent();
    const g = Graph.for_flow(d);
    expect(g.root).toBe('start');
    expect(g.reachable('start', new Set(['join']))).toEqual(new Set(['start', 'left', 'right']));
    expect(g.reaching('join', new Set(['start']))).toEqual(new Set(['left', 'right']));
    expect(g.dominators().get('join')).toEqual(new Set(['start', 'join']));
    expect(g.immediate_dominators().get('join')).toBe('start');
    expect(g.dominators().has('lost')).toBe(false);
    expect(Graph.for_flow(flow({}, 'missing')).dominators().size).toBe(0);
  });
  test('joins infer disjoint branches, including a direct route named for its origin', () => {
    const g = Graph.for_scope(diamond()), [infos, problems] = analyse_joins(g);
    expect(problems).toEqual([]);
    expect(infos.get('join')).toEqual({ origin: 'start', branches: new Map([['left', new Set(['left'])], ['right', new Set(['right'])]]), names: new Map([['left', 'left'], ['right', 'right']]), fanout: new Set() });
    const direct = Graph.for_scope(flow({ start: agent(['join', 'work']), work: agent('join'), join: { type: 'join' } }));
    expect(analyse_joins(direct)[0].get('join')?.branches.get('join')).toEqual(new Set());
    expect(analyse_joins(direct)[0].get('join')?.names.get('join')).toBe('start');
  });
  test('route groups compare kind/key structurally and separate exclusive choices', () => {
    const g = Graph.for_scope(flow({ start: agent({ a: 'left', b: 'right' }), left: agent('join'), right: agent('join'), join: { type: 'join' } }));
    expect([...route_groups(g, 'start', g.successors()).keys()]).toEqual(['["normal","a"]', '["normal","b"]']);
    expect(codes(g).some(p => p.includes('no route'))).toBe(true);
  });
  test('quorum uses exact comparison, accepting equivalent integer lexemes without a float ceiling', () => {
    for (const [raw, exceeds] of [['2e0', false], ['2.00000000000000000000001', true], ['900719925474099312345', true], ['1e999999999999999999', true]] as const) {
      const d = diamond(); Object.assign(d.flow.steps.join, { quorum: { count: new NumberToken(raw) } });
      expect(analyse_joins(Graph.for_scope(d))[1].some(p => p[1].at(-1) === 'count')).toBe(exceeds);
    }
  });
  test('fanouts close at their fork, permit runtime quorum and require each on every route', () => {
    const d = flow({ start: agent({ yes: { step: 'work', each: ['data'] }, no: 'work' }), work: agent('middle'), middle: agent('join'), join: { type: 'join', quorum: { count: new NumberToken('1e999') } } });
    const [infos, problems] = analyse_joins(Graph.for_scope(d));
    expect(infos.get('join')?.origin).toBe('start');
    expect(infos.get('join')?.fanout).toEqual(new Set(['work']));
    expect(problems.map(p => p[3])).toEqual([expect.stringContaining('start it with each on every route')]);
  });
  test('nested joins close internal forks before the outer join', () => {
    const d = flow({ start: agent(['fork', 'right']), fork: agent(['x', 'y']), x: agent('inner'), y: agent('inner'), inner: { type: 'join', next: 'join' }, right: agent('join'), join: { type: 'join' } });
    expect(analyse_joins(Graph.for_scope(d))[1]).toEqual([]);
    d.flow.steps.x.next = ['inner', 'join'];
    expect(codes(Graph.for_scope(d)).some(p => p.includes('inside and outside') || p.includes('not closed'))).toBe(true);
  });
  test('overlapping branches, external entry and error inputs have authored locations', () => {
    const d = flow({ start: agent(['a', 'b']), a: agent(['shared', 'join']), b: agent('shared'), shared: agent('join'), outside: agent('shared'), join: { type: 'join' } });
    const problems = analyse_joins(Graph.for_scope(d))[1];
    expect(problems.some(p => p[2] === 'shared' && p[3].includes('two branches'))).toBe(true);
    expect(problems.some(p => p[1].join('/') === 'flow/steps/outside/next' && p[3].includes('from outside'))).toBe(true);
    Object.assign(d.flow.steps.a, { onError: 'join' });
    expect(codes(Graph.for_scope(d)).some(p => p.includes('not one of its branches'))).toBe(true);
  });
  test('scope composition exits are synthetic; open forks are rejected unless one join closes them', () => {
    const d = { compositions: { body: { ...diamond().flow, outputs: ['done'] } } };
    Object.assign(d.compositions.body.steps.join, { next: { output: 'done' } });
    const g = Graph.for_scope(d, 'body');
    expect(g.nodes.get('#exit/done')?.type).toBe('exit');
    expect(open_body_forks(g, analyse_joins(g)[0])).toEqual([]);
    expect(open_body_forks(g, new Map()).length).toBe(1);
    const one = Graph.for_scope({ compositions: { body: { entry: 'start', steps: { start: agent({ step: 'end', each: ['data'] }), end: agent({ output: 'done' }) } } } }, 'body');
    expect(open_body_forks(one, new Map()).length).toBe(1);
  });
  test('expands nested compositions, forwards parameters and replaces output messages and fanouts', () => {
    const message = { prompt: { value: 'outer' } }, target = { step: 'end', message, each: ['data'] };
    const d = {
      compositions: {
        inner: { entry: 'work', steps: { work: { type: 'agent', agent: { parameter: 'p' }, next: { output: 'ok', message: { prompt: { value: 'discarded' } } } } } },
        outer: { entry: 'nested', steps: { nested: { type: 'compose', composition: 'inner', agents: { p: { parameter: 'q' } }, next: { ok: { output: 'ok' } } } } },
      },
      flow: { entry: 'start', steps: { start: { type: 'compose', composition: 'outer', agents: { q: 'actual' }, next: { ok: target } }, end: agent() } },
    };
    const g = Graph.for_flow(d), edge = g.edges[0];
    expect(g.root).toBe('start/nested/work');
    expect(g.nodes.get(g.root!)?.agent).toBe('actual');
    expect(g.nodes.get(g.root!)?.scope.prefix).toBe('start/nested');
    expect(edge).toMatchObject({ src: g.root, dst: 'end', message, fanout: target, pointer: ['flow', 'steps', 'start', 'next', 'ok'] });
    expect(Graph.for_composition(d, 'inner').nodes.has('#exit/ok')).toBe(true);
    expect(Graph.for_scope(d).nodes.get('start')?.type).toBe('compose');
  });
  test('composition recursion and missing references stop expansion without inventing nodes', () => {
    const d = { compositions: { body: { entry: 'again', steps: { again: { type: 'compose', composition: 'body' } } } }, flow: { entry: 'start', steps: { start: { type: 'compose', composition: 'body' } } } };
    expect(Graph.for_flow(d).root).toBeNull();
    expect(Graph.for_flow(flow({ start: { type: 'compose', composition: 'missing' } })).nodes.size).toBe(0);
  });
  test('flow error coverage excludes handler targets, branch members and own handlers', () => {
    const d = { flow: { entry: 'start', onError: 'handle', steps: { start: agent(['work', 'branch', 'own']), work: agent(), branch: agent(), own: { ...agent(), onError: 'handle' }, handle: agent() } } };
    expect(Graph.flow_error_covered(d, ['branch'])).toEqual(new Set(['start', 'work']));
    const covered = Graph.flow_error_covered(d, ['branch']);
    expect(Graph.for_scope(d, null, covered).edges.filter(e => e.kind === 'error').map(e => e.src)).toEqual(['own', 'start', 'work']);
    expect(Graph.for_flow(d, null, covered).edges.filter(e => e.kind === 'error').map(e => e.src)).toEqual(['start', 'work', 'own']);
  });
  test('inherited errors prefer a branch boundary, then compose, then flow', () => {
    const d = { compositions: { body: { entry: 'work', steps: { work: agent() } } }, flow: { entry: 'start', onError: 'fallback', steps: { start: { type: 'compose', composition: 'body', onError: 'handle' }, handle: agent(), fallback: agent() } } };
    expect(Graph.for_flow(d).edges[0]).toMatchObject({ src: 'start/work', dst: 'handle', kind: 'error', pointer: ['flow', 'steps', 'start', 'onError'] });
    expect(Graph.for_flow(d, new Map([['body', new Set(['work'])]])).edges).toEqual([]);
    delete (d.flow.steps.start as Record<string, unknown>).onError;
    expect(Graph.for_flow(d, null, new Set(['start'])).edges[0]).toMatchObject({ src: 'start/work', dst: 'fallback', pointer: ['flow', 'onError'] });
  });
  test('standalone primitives retain declaration-free exit and bound agent contracts', () => {
    const scope = new Scope({}, [], '', null, { p: 'bound' });
    expect(new Node('x', { type: 'agent', agent: { parameter: 'p' } }, scope, 'x').agent).toBe('bound');
    expect(new Node('x', { type: 'agent', agent: { parameter: 'constructor' } }, scope, 'x').agent).toBeNull();
    expect(new Node('#exit/x', null, scope, 'x').pointer).toEqual([]);
    expect(new Edge('a', 'b', 'normal', null, null, []).each).toBeNull();
  });
});
