import { expect, it } from 'bun:test';
import type { EngineActivation, EngineMemory, EngineTerminalCommit, HostAdmission, Prepare } from '../../types/generated/ipc';
import { loadFlowCapture } from './flowActivation';
import type { FlowAgent } from './flowActivation';
import { FlowPump, ResidentFlowHost, type FlowSchedulerPorts } from './flowScheduler';
import { deferred, flowDelivery, flowFixture, flowOwner, preparedFixture } from './flowTestFixtures';

/** Controlled IO observes scheduler ordering. This is not a substitute for the
 * repository's FIFO/atomicity tests or the native qualification scenes. */
async function harness(activations: EngineActivation[]) {
  const { inspection } = await flowFixture();
  inspection.projection.activations = activations;
  const capture = await loadFlowCapture(inspection);
  const calls: string[] = [];
  const requests: Prepare[] = [];
  const uncertaintyReasons: string[] = [];
  let terminal: EngineTerminalCommit | undefined;
  const ports: FlowSchedulerPorts = {
    owners: async () => [flowOwner], inspect: async () => inspection, load: async () => capture,
    begin: async (_owner, deliveryId) => {
      calls.push(`begin:${deliveryId}`);
      const activation = activations.find(item => item.delivery.deliveryId === deliveryId)!;
      activation.workState = 'active'; activation.admittedEpoch = flowOwner.ownerEpoch;
      return { kind: 'admitted', activation, memory: inspection.agents[0].memory };
    },
    execute: async (_owner, activation, memory) => {
      calls.push(`execute:${activation.delivery.work.activationId}`);
      return preparedFixture(activation, { memory });
    },
    visitLimit: async (_owner, activation) => {
      calls.push('visit-limit'); return preparedFixture(activation, { outcome: { kind: 'failed', code: 'VISIT_LIMIT', errorJson: '{"error":{"code":"VISIT_LIMIT","message":"limit","details":[]}}' } });
    },
    prepare: async request => { calls.push(`prepare:${request.work.activationId}`); requests.push(request); return `witness-${request.work.activationId}`; },
    commit: async (_owner, witness) => {
      calls.push(`commit:${witness}`);
      const request = requests.find(item => `witness-${item.work.activationId}` === witness)!;
      const activation = activations.find(item => item.delivery.work.activationId === request.work.activationId)!;
      activation.workState = 'terminal'; activation.terminal = request.outcome;
      inspection.agents[0].memory = request.memory;
      terminal = { owner: request.owner, work: request.work, outcome: request.outcome, memory: request.memory,
        responseCursor: request.responseCursor, terminationEvidenceJson: request.terminationEvidenceJson, outgoing: [] };
      return terminal;
    },
    uncertain: async (_owner, work, reason) => { uncertaintyReasons.push(reason); calls.push(`uncertain:${work.activationId}`); activations.find(item => item.delivery.work.activationId === work.activationId)!.workState = 'uncertain'; },
    yield: async () => { calls.push('yield'); },
  };
  return { inspection, capture, ports, calls, requests, uncertaintyReasons, terminal: () => terminal };
}
it('orders queueSequence rather than identity/arrival order and commits before the next admission', async () => {
  const f = await harness([flowDelivery('a', '10'), flowDelivery('z', '2')]);
  await new FlowPump('generation', flowOwner, f.ports).wake();
  expect(f.calls).toEqual(['begin:delivery-z', 'execute:z', 'prepare:z', 'commit:witness-z', 'begin:delivery-a', 'execute:a', 'prepare:a', 'commit:witness-a']);
});
it('coalesces wakes while a native terminal commit is pending without a second Agent call', async () => {
  const f = await harness([flowDelivery('first', '1'), flowDelivery('second', '2')]);
  const gate = deferred<void>(), entered = deferred<void>();
  const commit = f.ports.commit;
  f.ports.commit = async (...args) => { entered.resolve(); await gate.promise; return commit(...args); };
  const pump = new FlowPump('generation', flowOwner, f.ports), running = pump.wake();
  await entered.promise;
  for (let i = 0; i < 20; i++) expect(pump.wake()).toBe(running);
  expect(f.calls.filter(call => call.startsWith('execute'))).toEqual(['execute:first']);
  gate.resolve(); await running;
  expect(f.calls.filter(call => call.startsWith('execute'))).toEqual(['execute:first', 'execute:second']);
});
it('keeps a wake received while the final empty inspection is returning', async () => {
  const activation = flowDelivery('late', '1'), f = await harness([]);
  let reads = 0;
  const pump = new FlowPump('generation', flowOwner, f.ports);
  f.ports.inspect = async () => {
    reads++;
    if (reads === 1) { void pump.wake(); }
    if (reads === 2) f.inspection.projection.activations.push(activation);
    return f.inspection;
  };
  // Our IO begin/commit closures use the same projection array.
  await pump.wake();
  expect(f.calls).toContain('execute:late');
  expect(reads).toBeGreaterThanOrEqual(3);
});
it('leaves uncertain Agent FIFO to native admission and advances another Agent', async () => {
  const unknown = flowDelivery('unknown', '1'); unknown.workState = 'uncertain';
  const blocked = flowDelivery('blocked', '2'), other = flowDelivery('other', '3', 'work', 'other-instance');
  const f = await harness([unknown, blocked, other]);
  const begin = f.ports.begin;
  f.ports.begin = async (owner, id) => {
    if (id === blocked.delivery.deliveryId) { f.calls.push('waiting:uncertain'); return { kind: 'waiting', reason: 'uncertain' }; }
    return begin(owner, id);
  };
  await new FlowPump('generation', flowOwner, f.ports).wake();
  expect(f.calls.filter(call => call.startsWith('execute'))).toEqual(['execute:other']);
  expect(unknown.workState).toBe('uncertain'); expect(blocked.workState).toBe('queued');
});
it('marks one ambiguous execution uncertain and continues only other admissible Agents', async () => {
  const first = flowDelivery('first', '1'), second = flowDelivery('second', '2'), other = flowDelivery('other', '3', 'work', 'other-instance');
  const f = await harness([first, second, other]), begin = f.ports.begin, execute = f.ports.execute;
  f.ports.execute = async (...args) => { if (args[1].delivery.work.activationId === 'first') throw new Error('Lost physical receipt containing a private payload'); return execute(...args); };
  f.ports.begin = async (owner, id) => id === second.delivery.deliveryId ? { kind: 'waiting', reason: 'uncertain' } : begin(owner, id);
  await new FlowPump('generation', flowOwner, f.ports).wake();
  expect(first.workState).toBe('uncertain'); expect(second.workState).toBe('queued');
  expect(f.calls).toContain('execute:other'); expect(f.calls).not.toContain('prepare:first');
  expect(f.uncertaintyReasons).toEqual(['Resident activation lacks a confirmed terminal boundary; no continuation dispatched.']);
  expect(f.uncertaintyReasons.join('')).not.toContain('private payload');
});
it.each(['prepare', 'commit'] as const)('recovers a lost %s acknowledgement using the same no-effect continuation', async phase => {
  const f = await harness([flowDelivery('first', '1')]);
  let lost = true;
  if (phase === 'prepare') {
    const original = f.ports.prepare;
    f.ports.prepare = async request => { const id = await original(request); if (lost) { lost = false; throw new Error('Ack lost'); } return id; };
  } else {
    const original = f.ports.commit;
    f.ports.commit = async (...args) => { const receipt = await original(...args); if (lost) { lost = false; throw new Error('Ack lost'); } return receipt; };
  }
  const pump = new FlowPump('generation', flowOwner, f.ports);
  await pump.wake(); await pump.wake();
  expect(f.calls.filter(call => call === 'execute:first')).toHaveLength(1);
  expect(f.inspection.projection.activations[0].workState).toBe('terminal');
  if (phase === 'prepare') expect(f.requests[0]).toBe(f.requests[1]);
});
it('recovers a lost begin only from a native admitted no-effect boundary in the same generation', async () => {
  const first = flowDelivery('first', '1'), f = await harness([first]);
  const begin = f.ports.begin; let count = 0;
  f.ports.begin = async (...args) => {
    if (count++ === 0) { await begin(...args); throw new Error('Admission ack lost'); }
    return { kind: 'waiting', reason: 'active' };
  };
  const pump = new FlowPump('generation', flowOwner, f.ports);
  await pump.wake(); expect(f.calls).not.toContain('execute:first');
  await pump.wake();
  expect(f.calls.filter(call => call === 'execute:first')).toHaveLength(1);
  expect(first.workState).toBe('terminal');
});
it('does not infer redispatch from active admission with an existing effect or from an orphan', async () => {
  const first = flowDelivery('first', '1'); first.workState = 'active'; first.admittedEpoch = '3';
  const f = await harness([first]);
  await new FlowPump('generation', flowOwner, f.ports).wake();
  expect(f.calls).toEqual(['uncertain:first']);
  expect(first.workState).toBe('uncertain');
  const second = flowDelivery('second', '2'), g = await harness([second]);
  const begin = g.ports.begin; let count = 0;
  g.ports.begin = async (...args) => {
    if (count++ === 0) {
      await begin(...args);
      g.inspection.effects.push({ registered: { context: { owner: flowOwner, work: second.delivery.work, permissionsJson: '{}', scopeJson: '{}', registryVersion: g.capture.registry.version },
        effect: { kind: 'provider', providerAttemptId: 'physical-attempt' }, invocationJson: '{}' }, status: 'pending', settlement: null, resultJson: null });
      throw new Error('Lost begin');
    }
    return { kind: 'waiting', reason: 'active' };
  };
  const pump = new FlowPump('generation', flowOwner, g.ports); await pump.wake(); await pump.wake();
  expect(g.calls).not.toContain('execute:second'); expect(second.workState).toBe('uncertain');
});
it('resolves VISIT_LIMIT without Agent execution and uses the previous memory on the next admission', async () => {
  const first = flowDelivery('limit', '1'), second = flowDelivery('second', '2'), f = await harness([first, second]);
  const memory: EngineMemory = { agentInstanceId: 'worker-instance', revision: '7', formatVersion: 'synthetic', stateJson: '{}' };
  f.inspection.agents[0].memory = memory;
  const begin = f.ports.begin;
  f.ports.begin = async (...args): Promise<HostAdmission> => {
    if (args[1] === first.delivery.deliveryId) { first.workState = 'active'; return { kind: 'rejected', code: 'VISIT_LIMIT' }; }
    return begin(...args);
  };
  f.ports.visitLimit = async (_owner, activation) => preparedFixture(activation, { memory, outcome: { kind: 'failed', code: 'VISIT_LIMIT', errorJson: '{"error":{"code":"VISIT_LIMIT","message":"limit","details":[]}}' } });
  await new FlowPump('generation', flowOwner, f.ports).wake();
  expect(f.calls).not.toContain('execute:limit'); expect(f.requests[0].memory).toBe(memory); expect(f.requests[1].memory).toBe(memory);
});
it('retries a native prepared witness without reconstructing work, and ignores an old generation', async () => {
  const first = flowDelivery('first', '1'); first.workState = 'active';
  const f = await harness([first]), request = preparedFixture(first);
  f.requests.push(request);
  f.inspection.preparedTerminalsJson.push(JSON.stringify({ id: 'witness-first', generation: 'current', request, final_commit: null }));
  await new FlowPump('current', flowOwner, f.ports).wake();
  expect(f.calls).toEqual(['commit:witness-first']);
  const g = await harness([flowDelivery('old', '1')]); g.inspection.projection.activations[0].workState = 'active';
  g.inspection.preparedTerminalsJson.push(JSON.stringify({ id: 'old', generation: 'old-generation', request: preparedFixture(g.inspection.projection.activations[0]), final_commit: null }));
  await new FlowPump('new-generation', flowOwner, g.ports).wake();
  expect(g.calls).toEqual(['uncertain:old']);
});
it('polls Stop while Agent work remains awaited, and commits only after the physical boundary returns', async () => {
  const first = flowDelivery('first', '1'), f = await harness([first]);
  const entered = deferred<void>(), ended = deferred<void>(), signalled = deferred<void>();
  let stops = 0;
  f.ports.execute = async (_owner, activation, _memory, _inspection, _capture, onAgent) => {
    onAgent({ requestStop: () => { stops++; signalled.resolve(); } } as FlowAgent);
    entered.resolve(); await ended.promise;
    return preparedFixture(activation, { outcome: { kind: 'stopped', evidenceJson: '{}' } });
  };
  const host = new ResidentFlowHost('generation', f.ports);
  await host.poll(); await entered.promise;
  first.stopState = { kind: 'requested', requestId: 'stop' };
  await host.poll(); await signalled.promise;
  expect(stops).toBeGreaterThan(0); expect(f.calls.some(call => call.startsWith('commit'))).toBe(false);
  ended.resolve();
  // wake is a coalesced signal; inspect the same native state after completion.
  for (let i = 0; i < 20 && first.workState !== 'terminal'; i++) await Promise.resolve();
  expect(first.workState).toBe('terminal'); expect(first.terminal?.kind).toBe('stopped');
  host.close();
});
it('retirement during begin prevents an old owner from executing, and bounded catch-up yields', async () => {
  const first = flowDelivery('first', '1'), f = await harness([first]);
  const entered = deferred<void>(), release = deferred<void>(), begin = f.ports.begin;
  f.ports.begin = async (...args) => { entered.resolve(); await release.promise; return begin(...args); };
  const pump = new FlowPump('generation', flowOwner, f.ports), completion = pump.wake();
  await entered.promise; pump.retire(); release.resolve(); await completion;
  expect(f.calls).not.toContain('execute:first');
  const many = await harness(Array.from({ length: 40 }, (_, index) => flowDelivery(`work-${index}`, String(index + 1))));
  await new FlowPump('generation', flowOwner, many.ports).wake();
  expect(many.calls).toContain('yield');
});

it.each(['inspect', 'owners'] as const)('preserves an awaited Agent continuation after a lost %s read with an unchanged owner', async phase => {
  const first = flowDelivery('first', '1'), f = await harness([first]);
  const entered = deferred<void>(), ended = deferred<void>(), committed = deferred<void>();
  const checkpoint: EngineMemory = { agentInstanceId: 'worker-instance', revision: '1', formatVersion: 'synthetic', stateJson: '{"retained":"checkpoint"}' };
  let stops = 0, executions = 0, loseRead = false;
  const inspect = f.ports.inspect, owners = f.ports.owners;
  const failLostRead = () => {
    if (loseRead) { loseRead = false; throw new Error('Synthetic transient IPC read failure'); }
  };
  if (phase === 'inspect') f.ports.inspect = async owner => { failLostRead(); return inspect(owner); };
  else f.ports.owners = async () => { failLostRead(); return owners(); };
  f.ports.execute = async (_owner, activation, _memory, _inspection, _capture, onAgent) => {
    executions++;
    onAgent({ requestStop: () => { stops++; } } as FlowAgent);
    entered.resolve(); await ended.promise;
    return preparedFixture(activation, { memory: checkpoint });
  };
  const commit = f.ports.commit;
  f.ports.commit = async (...args) => { const receipt = await commit(...args); committed.resolve(); return receipt; };
  const host = new ResidentFlowHost('generation', f.ports);
  try {
    await host.poll(); await entered.promise;
    expect(first.stopState.kind).toBe('none'); expect(f.inspection.projection.systemStop.kind).toBe('none');
    loseRead = true;
    if (phase === 'owners') await expect(host.poll()).rejects.toThrow('Synthetic transient IPC read failure');
    else await host.poll();
    await host.poll();
    expect(stops).toBe(0); expect(executions).toBe(1); expect(first.workState).toBe('active');
    expect(f.calls.some(call => call.startsWith('uncertain') || call.startsWith('commit'))).toBe(false);
    ended.resolve(); await committed.promise;
    await host.poll();
    expect(first.workState).toBe('terminal'); expect(first.terminal?.kind).toBe('completed');
    expect(f.terminal()?.memory).toEqual(checkpoint);
    expect(f.calls.filter(call => call === 'begin:delivery-first')).toHaveLength(1);
    expect(f.calls.filter(call => call === 'prepare:first')).toHaveLength(1);
    expect(f.calls.filter(call => call === 'commit:witness-first')).toHaveLength(1);
    expect(f.calls.some(call => call.startsWith('uncertain'))).toBe(false);
    expect(stops).toBe(0); expect(executions).toBe(1);
  } finally { ended.resolve(); host.close(); }
});
it.each(['absent', 'replaced'] as const)('retires the awaited continuation only after its owner is established as %s', async change => {
  const first = flowDelivery('first', '1'), f = await harness([first]);
  const entered = deferred<void>(), ended = deferred<void>(), returned = deferred<void>();
  let stops = 0;
  f.ports.execute = async (_owner, activation, _memory, _inspection, _capture, onAgent) => {
    onAgent({ requestStop: () => { stops++; } } as FlowAgent);
    entered.resolve(); await ended.promise; returned.resolve();
    return preparedFixture(activation);
  };
  const host = new ResidentFlowHost('generation', f.ports);
  try {
    await host.poll(); await entered.promise;
    f.ports.owners = async () => change === 'absent' ? [] : [{ ...flowOwner, ownerEpoch: '2' }];
    // The replacement's unavailable inspection does not undo established fencing.
    f.ports.inspect = async () => { throw new Error('Replacement inspection unavailable'); };
    await host.poll();
    expect(stops).toBe(1);
    ended.resolve(); await returned.promise;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.calls.filter(call => call.startsWith('begin'))).toEqual(['begin:delivery-first']);
    expect(f.calls.some(call => call.startsWith('prepare') || call.startsWith('commit') || call.startsWith('uncertain'))).toBe(false);
  } finally { ended.resolve(); host.close(); }
});
