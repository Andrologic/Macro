import { expect, it } from 'bun:test';
import { associateMcpRequest030, HumanWaitRegistry030, WorkClock030 } from './workClock030';
it('measures 30s machine, 1h human, 40s machine as 70s', () => {
  const clock = new WorkClock030('60000', '0');
  clock.openHuman('ask', '30000');
  expect(clock.advance('3630000').elapsedMachineMs).toBe('30000');
  expect(clock.nextWakeMs()).toBeNull();
  clock.closeHuman('ask', '3630000');
  expect(clock.advance('3670000')).toMatchObject({ elapsedMachineMs: '70000', expired: true });
});
it('pauses for the union of concurrent requests and latches expiry', () => {
  const clock = new WorkClock030('100', '0');
  clock.openHuman('a', '30'); clock.openHuman('b', '40');
  clock.closeHuman('a', '90');
  expect(clock.advance('150').elapsedMachineMs).toBe('30');
  clock.closeHuman('b', '150');
  expect(clock.advance('220').expired).toBe(true);
  clock.openHuman('late', '220');
  expect(clock.advance('999').expired).toBe(true);
  expect(() => clock.advance('998')).toThrow('backwards');
});
it('resolves human deadlines at their exact time on a late tick; late answers cannot reopen', () => {
  const registry = new HumanWaitRegistry030(), clock = new WorkClock030('100', '0');
  registry.registerWork('w', clock, '50');
  registry.open({ requestId: 'a', kind: 'ask', reviewer: 'person', workIds: ['w'], openedAtMs: '20' });
  const expired = registry.tick('200');
  expect(expired[0]).toMatchObject({ expired: true, resolvedAtMs: '70', answer: { decision: 'no' }, workActions: [{ workId: 'w', action: 'continue' }] });
  expect(clock.snapshot()).toMatchObject({ elapsedMachineMs: '150', expired: true });
  expect(registry.resolve('a', { decision: 'yes' }, '201')).toEqual(expired[0]);
});
it('uses the shortest declared human limit, ignores unbounded works, counts model review', () => {
  const registry = new HumanWaitRegistry030(), a = new WorkClock030(null, '0'), b = new WorkClock030(null, '0'), c = new WorkClock030(null, '0');
  registry.registerWork('a', a, '1e2'); registry.registerWork('b', b, '50'); registry.registerWork('c', c, null);
  registry.open({ requestId: 'plan', kind: 'plan', reviewer: 'person', workIds: ['a', 'b', 'c'], openedAtMs: '10' });
  expect(registry.nextWakeMs('10')).toBe(50);
  expect(registry.tick('60')[0].workActions.every(item => item.action === 'PLAN_REJECTED')).toBe(true);
  registry.open({ requestId: 'model', kind: 'ask', reviewer: 'model', workIds: ['a'], openedAtMs: '60' });
  expect(registry.tick('1000')).toEqual([]);
  expect(a.snapshot().elapsedMachineMs).toBe('950');
});
it('handles ambiguous MCP calls, detached associations and no relevant work', () => {
  const works = [{ workId: 'a', servers: ['s'], callsInProgress: [] }, { workId: 'b', servers: ['s'], callsInProgress: ['s'] }];
  expect(associateMcpRequest030('s', true, works)).toEqual(['b']);
  expect(associateMcpRequest030('s', false, works)).toEqual(['a', 'b']);
  expect(associateMcpRequest030('other', true, works)).toEqual([]);
  const registry = new HumanWaitRegistry030(), clock = new WorkClock030(null, '0');
  registry.registerWork('w', clock, '10');
  registry.open({ requestId: 'q', kind: 'question', reviewer: 'person', workIds: ['w'], openedAtMs: '0' });
  registry.setRequestWorks('q', [], '5');
  expect(registry.tick('100')).toEqual([]);
  expect(clock.snapshot().elapsedMachineMs).toBe('95');
  expect(registry.resolve('q', { decision: 'no' }, '100').workActions).toEqual([]);
});
it('keeps unlimited requests open and slices huge exact deadlines', () => {
  const registry = new HumanWaitRegistry030(), clock = new WorkClock030('1e999999999999', '0');
  registry.registerWork('w', clock, '1e999999999999');
  const input = { requestId: 'q', kind: 'question', reviewer: 'person', workIds: ['w'], openedAtMs: '0' } as const;
  registry.open(input);
  expect(registry.open(input).resolution).toBeNull();
  expect(registry.nextWakeMs('9007199254740993')).toBe(2147483647);
  expect(registry.resolve('q', { decision: 'no' }, '9007199254740993').workActions[0].action).toBe('continue');
});
