import { expect, it } from 'bun:test';
import { loadRuntimeProjection030, selectRuntimeProjection030 } from './runtimeProjection030';
import type { RuntimeProjectionScope030 } from '../../types/generated/ipc/RuntimeProjectionScope030';
import type { RuntimeProjectionPage030 } from '../../types/generated/ipc/RuntimeProjectionPage030';
import type { RuntimeProjectionItem030 } from '../../types/generated/ipc/RuntimeProjectionItem030';
const scope: RuntimeProjectionScope030 = {systemStartId:'run',snapshotId:'capture',source:{owner:{projectId:'p',planId:'plan',branch:'main'},revision:'2',sourceSha256:'a'.repeat(64)}};
const instance = (id: string): RuntimeProjectionItem030 => ({kind:'instance',value:{id,agent:'worker',selectorKind:'shared',selectorName:null,currentActivationId:'a',queueActivationIds:['a2','a1'],discarded:false}});
const group: RuntimeProjectionItem030 = {kind:'group',value:{id:'g',join:['join'],originActivationId:'a',activationId:'b',decision:null,released:false,context:[{kind:'path',pathId:'p',departedGroups:['g0']}],parentPathIds:['p'],branches:[{name:'second',fanout:true,pathIds:['p2','p1']},{name:'first',fanout:false,pathIds:['p0']}]}};
const first: RuntimeProjectionPage030 = {scope,flowInvocationId:'flow',revision:'9',stopping:false,verdict:null,total:'101',items:Array.from({length:100},(_,i)=>instance(String(i).padStart(3,'0'))),nextPage:{scope,revision:'9',offset:100}};
const last: RuntimeProjectionPage030 = {...first,items:[group],nextPage:null};
it('assembles a full ordered revision while retaining native branch and queue order', async () => {
  const result = await loadRuntimeProjection030(scope,'flow',async (_scope, next)=> next ? last : first,()=>true);
  expect(result?.items).toHaveLength(101);
  const found = selectRuntimeProjection030(result!,'group','g');
  expect(found?.kind === 'group' && found.value.branches.map(branch=>branch.name)).toEqual(['second','first']);
  expect(found?.kind === 'group' && found.value.branches[0].pathIds).toEqual(['p2','p1']);
  const queue = selectRuntimeProjection030(result!,'instance','000');
  expect(queue?.kind === 'instance' && queue.value.queueActivationIds).toEqual(['a2','a1']);
});
it('binds a nullable first query to the native capture returned for subsequent pages', async () => {
  const queries: (string | null)[] = [];
  const result = await loadRuntimeProjection030({...scope,snapshotId:null},'flow',async (query, next) => {
    queries.push(query.snapshotId);
    return next ? last : first;
  },()=>true);
  expect(queries).toEqual([null,'capture']);
  expect(result?.scope.snapshotId).toBe('capture');
  await expect(loadRuntimeProjection030({...scope,snapshotId:null},'flow',async (_query,next) => next ? {...last,scope:{...scope,snapshotId:'changed'}} : first,()=>true)).rejects.toThrow();
});
it('rejects truncated, repeated, foreign, out-of-order and inconsistent pages', async () => {
  const run = (second: RuntimeProjectionPage030) => loadRuntimeProjection030(scope,'flow',async (_s,next)=>next ? second : first,()=>true);
  await expect(run({...last,items:[]})).rejects.toThrow();
  await expect(run({...last,total:'102'})).rejects.toThrow();
  await expect(run({...last,revision:'10'})).rejects.toThrow();
  await expect(run({...last,scope:{...scope,snapshotId:'other'}})).rejects.toThrow();
  await expect(run({...last,items:[instance('099')]})).rejects.toThrow();
  await expect(run({...last,flowInvocationId:'foreign'})).rejects.toThrow();
  await expect(loadRuntimeProjection030(scope,'flow',async()=>({...first,nextPage:{scope,revision:'9',offset:99}}),()=>true)).rejects.toThrow();
});
it('abandons a partial view on conflict or after a run switch', async () => {
  await expect(loadRuntimeProjection030(scope,'flow',async (_s,next)=>next ? Promise.reject({code:'CONFLICT'}) : first,()=>true)).rejects.toMatchObject({code:'CONFLICT'});
  let current = true;
  const result = await loadRuntimeProjection030(scope,'flow',async()=>{current=false;return first;},()=>current);
  expect(result).toBeUndefined();
});

it('compares public IDs by UTF-8 order without changing native decimal indices or contexts', async () => {
  const activation: RuntimeProjectionItem030 = {kind:'activation',value:{id:'a',step:['outer','work'],agent:'worker',instanceId:'i',phase:'running',physical:true,physicalWaitGroupIds:['g'],stopRequested:false,context:[{kind:'compose',activationId:'outer'},{kind:'path',pathId:'p',departedGroups:['g']}],pathIds:['p'],composeActivationIds:['outer'],nearestFanoutIndex:'900719925474099312345'}};
  const page: RuntimeProjectionPage030 = {...last,total:'3',items:[instance('\uE000'),instance('😀'),activation]};
  const result = await loadRuntimeProjection030(scope,'flow',async()=>page,()=>true);
  const selected = selectRuntimeProjection030(result!,'activation','a');
  expect(selected?.kind === 'activation' && selected.value.nearestFanoutIndex).toBe('900719925474099312345');
  expect(selected?.kind === 'activation' && selected.value.context).toEqual(activation.value.context);
  expect(selected?.kind === 'activation' && selected.value.physicalWaitGroupIds).toEqual(['g']);
  await expect(loadRuntimeProjection030(scope,'flow',async()=>({...page,items:[instance('😀'),instance('\uE000'),activation]}),()=>true)).rejects.toThrow();
});

it('rejects unknown runtime discriminants instead of publishing hidden items', async () => {
  for (const kind of ['future', 'toString']) {
    const item = {kind, value:{id:'id'}} as unknown as RuntimeProjectionItem030;
    const page = {...last,total:'1',items:[item]};
    await expect(loadRuntimeProjection030(scope,'flow',async()=>page,()=>true)).rejects.toThrow();
  }
});

import { initialRunSelection030 } from './runtimeProjection030';
import { available, historyFixture030, humanFixture030, inspectionFixture030, monitorFixture030, ready } from './runInspection030.testSupport';
it('applies explicit, newest attested human wait, retained admission, then newest run priority', () => {
  const a = inspectionFixture030('a'), b = inspectionFixture030('b');
  const base = monitorFixture030(a, b).snapshot;
  expect(initialRunSelection030(base)).toBe('a');
  const admitted = { ...base, retainedAdmission: available('b') };
  expect(initialRunSelection030(admitted)).toBe('b');
  const waiting = { ...admitted, history: ready([{ ...historyFixture030(a), humans: ready([humanFixture030(a)]) }, { ...historyFixture030(b), humans: ready([humanFixture030(b)]) }]) };
  expect(initialRunSelection030(waiting)).toBe('a');
  expect(initialRunSelection030(waiting, 'b')).toBe('b');
  expect(initialRunSelection030(waiting, 'removed')).toBe('a');
  expect(initialRunSelection030({ ...waiting, history: { kind: 'loading', retained: waiting.history.kind === 'ready' ? waiting.history.value : null } })).toBeUndefined();
  expect(initialRunSelection030({ ...base, history: ready([{ ...historyFixture030(a), humans: { kind: 'unavailable', gap: 'human-flow-projection' } }, historyFixture030(b)]) })).toBeUndefined();
  expect(initialRunSelection030({ ...base, retainedAdmission: { kind: 'unavailable', gap: 'chronology' } })).toBeUndefined();
});

it('ignores unknown older waits once the highest-priority human wait is attested', () => {
  const recent = inspectionFixture030('recent'), old = inspectionFixture030('old');
  const recentWaiting = { ...historyFixture030(recent), humans: ready([humanFixture030(recent)]) };
  const olderUnknown = { ...historyFixture030(old), humans: { kind: 'unavailable' as const, gap: 'human-flow-projection' as const } };
  const base = monitorFixture030(recent, old).snapshot;
  expect(initialRunSelection030({ ...base, history: ready([recentWaiting, olderUnknown]) })).toBe('recent');
  expect(initialRunSelection030({ ...base, history: ready([olderUnknown, recentWaiting]) })).toBeUndefined();
  expect(initialRunSelection030({ ...base, history: ready([historyFixture030(recent), olderUnknown]) })).toBeUndefined();
});
