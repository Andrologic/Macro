import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus, platform, release, arch, totalmem, loadavg } from 'node:os';
import { loadConversationMessages, type ChatPersistenceAdapters } from '../../src/services/chatPersistenceService';
import type { DbMessage } from '../../src/services/tauriIpc';
import { buildMessageState } from '../../src/stores/chat/chatMessageState';
import { buildChatTranscriptItems } from '../../src/components/chat/transcriptItems';
import { createChatTurnRuntime } from '../../src/services/chatTurnRuntime';
import { EMPTY_CONVERSATION_RUNTIME } from '../../src/domains/chat/runtimeState';
import type { ConversationRuntimeState } from '../../src/types';
import { createLifecycleScope } from '../../src/services/lifecycleScope';
import { createActiveStreamResources, activeStreamResourcesBySessionId, cancelStream } from '../../src/services/ai/streamResources';
import { SubagentRuntime } from '../../src/services/subagentRuntime/SubagentRuntime';
import { assertCleanBuildSource } from './build-provenance';
import { benchmark, distribution } from './stats';
import { fixtureSizes } from './fixtures';

const root = new URL('../../', import.meta.url);
const unavailable = () => { throw new Error('Unexpected IPC operation'); };
export function historyFixture(size: number, nested: boolean): DbMessage[] {
  assert.ok(Number.isInteger(size) && size > 0);
  return Array.from({ length: size }, (_, i) => ({
    id: `seed-${String(i).padStart(6, '0')}`, conversation_id: 'synthetic-conversation',
    turn_id: null, role: nested && i % 2 ? 'assistant' : 'user', content: 'x'.repeat(256),
    created_at: '2026-01-01T00:00:00Z', token_count: null, hidden_context: null,
    tool_traces_json: nested ? JSON.stringify([{ tool_call_id: `tool-${i}`, tool_name: 'synthetic', status: 'done', detail: 'x'.repeat(128) }]) : null,
    provider_input_items_json: nested ? JSON.stringify([{ type: 'message', content: [{ type: 'input_text', text: 'x'.repeat(256) }] }]) : null,
    provider_turn_state_json: nested ? JSON.stringify({ provider: 'chatgpt', output_items: [{ type: 'message', content: [{ type: 'text', text: 'x'.repeat(256) }] }] }) : null,
    context_refs_json: null, completion_reason: null, generation_attempts_json: null,
  }));
}
function adaptersFor(rows: DbMessage[]): ChatPersistenceAdapters {
  return { isTauriAvailable: () => true, ipc: {
    listMessages: async () => rows,
    getChatBootstrapSnapshot: unavailable, listConversations: unavailable, createMessage: unavailable,
    updateMessage: unavailable, renameConversation: unavailable, deleteConversation: unavailable,
    deleteConversations: unavailable, deleteMessagesAfter: unavailable, deleteConversationTurn: unavailable,
  } };
}
export async function measureHistory(size: number, nested: boolean, warmup = 10, samples = 100) {
  const rows = historyFixture(size, nested);
  const json = JSON.stringify(rows);
  let decoded: DbMessage[] = JSON.parse(json);
  const decode = benchmark(() => { decoded = JSON.parse(json); }, warmup, samples);
  assert.deepEqual(decoded, rows);
  const adapters = adaptersFor(decoded);
  const mapped = await loadConversationMessages(adapters, { conversationId: 'synthetic-conversation', conversations: [] });
  assert.equal(mapped.length, size);
  assert.equal(mapped[0].content, rows[0].content);
  if (nested) {
    assert.equal(mapped[0].provider_input_items?.length, 1);
    assert.equal(mapped[0].tool_traces?.length, 1);
    if (size > 1) assert.equal(mapped[1].provider_turn_state?.output_items.length, 1);
  }
  const mapping: number[] = [];
  for (let i = 0; i < warmup + samples; i++) {
    const start = performance.now();
    const messages = await loadConversationMessages(adapters, { conversationId: 'synthetic-conversation', conversations: [] });
    const ms = performance.now() - start;
    assert.equal(messages.length, size);
    if (i >= warmup) mapping.push(ms);
  }
  const state = buildMessageState(mapped);
  assert.equal(state.messagesByConversationId['synthetic-conversation'].length, size);
  assert.equal(state.messagesByConversationId['synthetic-conversation'][0], mapped[0]);
  assert.equal(state.messageIndexById[mapped.at(-1)!.id], size - 1);
  let sink = 0;
  const indexing = benchmark(() => { sink += buildMessageState(mapped).messages.length; }, warmup, samples);
  const transcript = benchmark(() => { sink += buildChatTranscriptItems(mapped).length; }, warmup, samples);
  return { size, nested, jsonBytes: Buffer.byteLength(json), decodeJson: decode,
    loadConversationMessages: { unit: 'ms', warmup, ...distribution(mapping) }, buildMessageState: indexing,
    transcriptItems: transcript, sink,
    retainedState: { uniqueMessages: size, messageArrayReferences: size * 2, idIndexEntries: size,
      contentCopiesInIndexes: 0 },
  };
}

const memory = () => ({ ...process.memoryUsage() });
/** Actual production owners, synthetic boundaries. No transport/provider/process launch. */
export async function resourceCycles(cycles: number, checkpointEvery: number) {
  assert.ok(Number.isInteger(cycles) && cycles > 0);
  assert.ok(Number.isInteger(checkpointEvery) && checkpointEvery > 0);
  assert.equal(activeStreamResourcesBySessionId.size, 0, 'Run only in a fresh standalone process');
  const states = new Map<string, ConversationRuntimeState>();
  const historyAdapters = adaptersFor(historyFixture(100, false));
  let historyState = buildMessageState([]);
  let settled = 0, cancellations = 0, released = 0, events = 0, pendingTimers = 0;
  const turns = createChatTurnRuntime({ state: {
    read: id => states.get(id) ?? EMPTY_CONVERSATION_RUNTIME,
    project: (id, state) => { if (state) states.set(id, state); else states.delete(id); },
    isDeleted: () => false,
  }, cancelTransport: () => { cancellations++; }, settled: () => { settled++; } });
  const subagentTimers = new Set<ReturnType<typeof setTimeout>>();
  const subagents = new SubagentRuntime({ executor: { execute: async () => ({ text: 'synthetic output' }) },
    clock: { now: () => Date.now(), setTimeout: (callback, delay) => {
      const handle = setTimeout(() => { subagentTimers.delete(handle); callback(); }, delay);
      subagentTimers.add(handle);
      return handle;
    }, clearTimeout: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>); subagentTimers.delete(handle as ReturnType<typeof setTimeout>); } },
  });
  let notifications = 0;
  const unsubscribe = subagents.subscribe(() => { notifications++; });
  const checkpoints: unknown[] = [];
  const collect = (completed: number) => {
    // Diagnostic collection only. Never infer WebView GC or a leak from RSS.
    const beforeGC = memory();
    Bun.gc(true);
    checkpoints.push({ completed, beforeGC, afterGC: memory(), states: states.size,
      streamRegistry: activeStreamResourcesBySessionId.size, pendingTimers, subagentTimers: subagentTimers.size,
      retainedSubagentSnapshots: subagents.listSnapshots().length, retainedHistoryMessages: historyState.messages.length,
      settled, cancellations, released, events });
  };
  collect(0);
  for (let i = 0; i < cycles; i++) {
    // Reopen the same history through production mapping/index helpers. The
    // synthetic owner replaces it rather than accumulating new conversations.
    historyState = buildMessageState(await loadConversationMessages(historyAdapters,
      { conversationId: 'synthetic-conversation', conversations: [] }));
    assert.equal(historyState.messages.length, 100);
    const id = `synthetic-${i}`;
    const identity = { conversationId: id, sessionId: id, turnId: id, assistantMessageId: id };
    const controller = new AbortController();
    turns.rememberSession(id, id);
    turns.set(id, { ...identity, phase: 'preparing', abortController: controller, lastError: null });
    assert.ok(turns.claimStream(identity, controller)?.());
    turns.enqueueSteer(id, { role: 'user', content: 'synthetic steer' });
    assert.equal(turns.consumeSteers(identity).length, 1);
    turns.track(id, Promise.resolve());
    await turns.drain(id);
    if (i % 2) {
      turns.stop(id);
      assert.ok(controller.signal.aborted);
    } else {
      assert.ok(turns.beginCompletion(identity));
      assert.ok(turns.ownsCompletion(identity));
      turns.releaseCompletion(identity);
      assert.equal(turns.ownsCompletion(identity), false);
    }
    turns.forget(id);
    turns.set(id, null);
    assert.equal(turns.latestSession(id), undefined);
    const stream = createActiveStreamResources(id);
    stream.stream = new ReadableStream({ cancel() { released++; } });
    cancelStream(id);
    assert.equal(activeStreamResourcesBySessionId.has(id), false);
    const scope = createLifecycleScope();
    const target = new EventTarget();
    const listener = () => { events++; };
    target.addEventListener('synthetic', listener);
    scope.own(() => target.removeEventListener('synthetic', listener));
    pendingTimers++;
    const timer = setTimeout(() => { throw new Error('Owned timer survived scope.stop'); }, 60_000);
    scope.own(() => { clearTimeout(timer); pendingTimers--; });
    scope.track(Promise.resolve());
    target.dispatchEvent(new Event('synthetic'));
    scope.stop();
    scope.stop();
    target.dispatchEvent(new Event('synthetic'));
    await scope.drain();
    const result = await subagents.run({ runId: id, parentConversationId: 'synthetic-parent', parentDepth: 0, input: null, timeoutMs: 60_000 }).result;
    assert.equal(result.status, 'completed');
    if ((i + 1) % checkpointEvery === 0 || i + 1 === cycles) collect(i + 1);
  }
  await subagents.whenIdle();
  unsubscribe();
  const notificationsAtUnsubscribe = notifications;
  const unsubscribeProbe = subagents.run({ runId: 'synthetic-unsubscribe-probe', parentConversationId: 'synthetic-parent', parentDepth: 0, input: null });
  assert.equal((await unsubscribeProbe.result).status, 'completed');
  assert.equal(subagents.releaseRun(unsubscribeProbe.runId), true);
  assert.equal(notifications, notificationsAtUnsubscribe, 'Unsubscribed listener received a new run');
  await subagents.dispose();
  assert.equal(notifications, notificationsAtUnsubscribe);
  assert.equal(settled, cycles);
  assert.equal(released, cycles);
  assert.equal(events, cycles);
  assert.equal(cancellations, Math.floor(cycles / 2));
  assert.equal(pendingTimers, 0);
  assert.equal(states.size, 0);
  assert.equal(activeStreamResourcesBySessionId.size, 0);
  const snapshotsAfterDispose = subagents.listSnapshots().length;
  assert.equal(snapshotsAfterDispose, cycles);
  assert.equal(subagentTimers.size, 0);
  collect(cycles);
  for (let i = 0; i < cycles; i++) assert.equal(subagents.releaseRun(`synthetic-${i}`), true);
  assert.equal(subagents.listSnapshots().length, 0);
  collect(cycles);
  return { cycles, checkpointEvery, checkpoints, snapshotsAfterDispose, snapshotsAfterRelease: subagents.listSnapshots().length, notifications,
    boundary: 'Bun process; production chatTurnRuntime/lifecycleScope/streamResources/SubagentRuntime, synthetic state/stream/executor; no WebView, native listeners, PTY or provider',
    checks: { settled, releasedStreams: released, deliveredEvents: events, cancelledTurns: cancellations,
      pendingOwnedTimers: pendingTimers, projectedStates: states.size, activeStreamRegistry: activeStreamResourcesBySessionId.size, pendingSubagentTimers: subagentTimers.size },
    retainedHistoryMessages: historyState.messages.length,
    retained: 'SubagentRuntime keeps completed snapshots and run records for its lifetime, including after dispose, until explicit releaseRun. Last checkpoint follows releaseRun of all completed runs. Counts are data retention, not proof of a leak; the empty parent pool remains until runtime collection.',
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--self-test')) throw new Error('Usage: bun dev/performance/history-resources.ts [--self-test]');
  const smoke = args[0] === '--self-test';
  const head = assertCleanBuildSource(root);
  const startLoad = loadavg();
  const rows = [];
  for (const size of smoke ? [3] : fixtureSizes) {
    for (const nested of [false, true]) rows.push(await measureHistory(size, nested, smoke ? 1 : 10, smoke ? 3 : 100));
  }
  const retention = await resourceCycles(smoke ? 6 : 10_000, smoke ? 3 : 1_000);
  assert.equal(assertCleanBuildSource(root), head, 'Source changed during measurement');
  console.log(JSON.stringify({ schema: 1, kind: 'history-load-and-resource-cycles',
    provenance: { head, dirty: false, timestamp: new Date().toISOString(), bun: Bun.version,
      lockfileSha256: createHash('sha256').update(readFileSync(new URL('../../bun.lock', import.meta.url))).digest('hex') },
    environment: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model,
      cpuCount: cpus().length, memoryGiB: totalmem() / 2 ** 30, startLoad, endLoad: loadavg() },
    protocol: { warmup: smoke ? 1 : 10, samples: smoke ? 3 : 100, percentile: 'nearest-rank',
      boundary: 'JSON.parse in Bun, production persistence mapping with immediate synthetic IPC adapter, production indexes and transcript items measured separately; excludes native transport/React/layout',
      gc: 'No forced GC in timings; forced full Bun GC at retention checkpoints only; RSS includes allocator/JIT/runtime and is not retained-object size' },
    rows, retention,
    unavailable: ['Tauri IPC encode/transport/decode', 'WebView heap/DOM/native resources', 'actual PTY/process lifecycle', 'real browser listeners and xterm runtime', 'React rendering and visual readiness'],
  }, null, 2));
}
