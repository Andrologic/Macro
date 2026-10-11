import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MacroPilotNativeClient, PilotPublicState } from './macroPilot/nativeClient';
import { beginAppShutdownGate, isAppShutdownGateActive, resetAppShutdownGateForTests } from './appShutdownGate';

let stored: string | null = null;
let polls = 0;
let subscriptions = 0;
let blockedPoll: Promise<void> | null = null;
let disconnect: () => Promise<void> = async () => undefined;
const flush = mock(async () => undefined);
const state = { status: 'connected', configurationId: 'config:test', instance: { ref: { instance_id: 'instance:test' }, label: 'Macro' }, deviceSession: { state: 'active', ref: { session_id: 'session:test' } } } as PilotPublicState;
mock.module('./macroPilot/nativeClient', () => ({
  macroPilotNativeClient: {
    getState: () => state,
    initialize: async () => state,
    subscribe: () => { subscriptions++; return () => { subscriptions--; }; },
    request: (async (_method: string, path: string, _body: unknown, options: { signal?: AbortSignal }) => {
      if (path.endsWith('/disconnect')) { await disconnect(); return { status: 204, data: null }; }
      polls++;
      if (blockedPoll) await blockedPoll;
      await new Promise<void>(resolve => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw Error('Aborted');
    }) as MacroPilotNativeClient['request'],
  },
}));
mock.module('./macroPilot/storage', () => ({
  pilotKernelStorage: () => ({
    load: async () => stored,
    compareAndSwap: async (previous: string | null, next: string) => {
      if (previous !== stored) return false;
      stored = next;
      return true;
    },
  }),
}));
mock.module('./macroMetadataCoordinator', () => ({ flushMacroMetadata: flush, flushPendingMacroMetadata: flush, recordMacroMetadataMutation: () => undefined }));
const { macroPilotRuntime: runtime } = await import('../composition/macroPilotDesktop');
const { runWithPotentialShutdown } = await import('./windowShutdown');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('recoverable shutdown with the real Pilot runtime and kernel', () => {
  beforeEach(() => {
    stored = null; polls = 0; subscriptions = 0; blockedPoll = null;
    disconnect = async () => undefined;
    flush.mockReset(); flush.mockImplementation(async () => undefined);
    resetAppShutdownGateForTests();
  });
  afterEach(async () => { await runtime.stop(); resetAppShutdownGateForTests(); });

  it('resumes after a flush failure only after the pending stop finishes', async () => {
    await runtime.start(); await tick();
    expect(runtime.getStatus()).toBe('running');
    let finishStop!: () => void;
    disconnect = () => new Promise<void>(resolve => { finishStop = resolve; });
    flush.mockImplementationOnce(async () => { throw Error('Save failed'); });
    const operation = mock(async () => true);
    let settled = false;
    const attempt = runWithPotentialShutdown(operation, beginAppShutdownGate(), runtime).catch(error => { settled = true; return error; });
    await tick();
    expect(isAppShutdownGateActive()).toBe(false);
    expect(settled).toBe(false);
    expect(subscriptions).toBe(0);
    finishStop();
    expect(await attempt).toBeInstanceOf(Error);
    await tick();
    expect(runtime.getStatus()).toBe('running');
    expect(subscriptions).toBe(1);
    expect(polls).toBe(2);
    expect(operation).not.toHaveBeenCalled();
    disconnect = async () => undefined;
  });

  it('does not activate a runtime that was stopped before preparation', async () => {
    expect(await runWithPotentialShutdown(async () => false, beginAppShutdownGate(), runtime)).toBe(false);
    expect(runtime.isStarted()).toBe(false);
    expect(subscriptions).toBe(0);
    expect(polls).toBe(0);
  });

  it('keeps Pilot stopped after a successful native operation', async () => {
    await runtime.start(); await tick();
    expect(await runWithPotentialShutdown(async () => true, beginAppShutdownGate(), runtime)).toBe(true);
    expect(isAppShutdownGateActive()).toBe(true);
    expect(runtime.isStarted()).toBe(false);
    expect(subscriptions).toBe(0);
    expect(polls).toBe(1);
  });

  it('rejects an overlapping attempt without creating a second producer', async () => {
    await runtime.start(); await tick();
    let rejectOperation!: () => void;
    const first = runWithPotentialShutdown(() => new Promise<false>(resolve => { rejectOperation = () => resolve(false); }), beginAppShutdownGate(), runtime);
    await tick();
    await expect(runWithPotentialShutdown(async () => false, beginAppShutdownGate(), runtime)).rejects.toThrow('already in progress');
    expect(subscriptions).toBe(0);
    rejectOperation();
    expect(await first).toBe(false);
    await Promise.all([runtime.start(), runtime.start()]);
    await tick();
    expect(subscriptions).toBe(1);
    expect(polls).toBe(2);
  });

  it('exposes retry when another shutdown gate still prevents resumption', async () => {
    await runtime.start(); await tick();
    const releaseOtherGate = beginAppShutdownGate();
    expect(await runWithPotentialShutdown(async () => false, beginAppShutdownGate(), runtime)).toBe(false);
    expect(runtime.getStatus()).toBe('unavailable');
    expect(subscriptions).toBe(0);
    releaseOtherGate();
    await runtime.retry(); await tick();
    expect(runtime.getStatus()).toBe('running');
    expect(subscriptions).toBe(1);
  });
  it('keeps a blocked old producer fenced and exposes a bounded retry', async () => {
    let finishPoll!: () => void;
    blockedPoll = new Promise<void>(resolve => { finishPoll = resolve; });
    await runtime.start(); await tick();
    expect(await runWithPotentialShutdown(async () => false, beginAppShutdownGate(), runtime)).toBe(false);
    expect(runtime.getStatus()).toBe('unavailable');
    expect(subscriptions).toBe(0);
    expect(polls).toBe(1);
    finishPoll(); blockedPoll = null;
    await tick();
    expect(runtime.getStatus()).toBe('unavailable');
    await runtime.retry(); await tick();
    expect(runtime.getStatus()).toBe('running');
    expect(subscriptions).toBe(1);
    expect(polls).toBe(2);
  });

});
