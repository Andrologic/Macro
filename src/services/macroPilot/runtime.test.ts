import { describe, expect, it } from 'bun:test';
import { PilotRuntime } from './runtime';
import { PilotKernel } from './kernel';
import type { MacroPilotNativeClient, PilotPublicState } from './nativeClient';
import type { Resource } from './protocol';
import taskFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/task.json';
import commandFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/task-reply-command.json';

describe('Pilot producer delivery loop', () => {
  it('reauthorizes before the effect and retries a lost result without dispatching twice', async () => {
    let stored: string | null = null;
    let effects = 0;
    let authorizations = 0;
    let polls = 0;
    const results: unknown[] = [];
    let finished!: () => void;
    const complete = new Promise<void>(resolve => { finished = resolve; });
    const task = { ...structuredClone(taskFixture), revision: 7, state: 'waiting_reply', reply_context: { conversation_id: 'conversation:test' } } as Resource;
    const command = { ...structuredClone(commandFixture), target: task.ref, payload: { conversation_id: 'conversation:test', answer: 'Continue.' } };
    const delivery = { transport_version: '1.0', type: 'delivery', delivery_id: 'delivery:test', exchange_id: 'exchange:test', actor: command.issued_by, message: command };
    const state = { status: 'connected', configurationId: 'config:test', instance: { ref: { instance_id: task.ref.instance_id } }, deviceSession: { state: 'active', ref: { session_id: 'session:test' } } } as PilotPublicState;
    const client: Pick<MacroPilotNativeClient, 'getState' | 'subscribe' | 'initialize' | 'request'> = {
      getState: () => state,
      subscribe: () => () => undefined,
      initialize: async () => state,
      request: (async (_method: string, path: string, body: unknown, options: { signal?: AbortSignal }) => {
        if (path.endsWith('/authorize')) {
          authorizations++;
          return { status: 200, data: { execute_before: new Date(Date.now() + 5000).toISOString() }, requestId: 'request:test' };
        }
        if (path.endsWith('/result')) {
          results.push(structuredClone(body));
          if (results.length === 1) throw new Error('Lost result response');
          finished();
          return { status: 204, data: null, requestId: 'request:test' };
        }
        if (path.endsWith('/disconnect')) return { status: 204, data: null, requestId: 'request:test' };
        if (polls++ === 0) return { status: 200, data: delivery, requestId: 'request:test' };
        await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('Aborted');
      }) as MacroPilotNativeClient['request'],
    };
    const runtime = new PilotRuntime(client, dependencies => new PilotKernel({
      ...dependencies,
      storage: { load: async () => stored, compareAndSwap: async (previous, next) => {
        if (previous !== stored) return false;
        stored = next; return true;
      } },
      project: () => ({ snapshots: [task], state: null }),
      execute: async (_command, guard) => {
        await guard.authorizeBeforeEffect();
        effects++;
      },
    }));
    try {
      await runtime.start();
      await complete;
      expect(authorizations).toBe(2);
      expect(effects).toBe(1);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual(results[1]);
    } finally { await runtime.stop(); }
  });
  it('exposes a corrupt journal and allows an explicit retry after local repair', async () => {
    let stored: string | null = '{invalid';
    let polls = 0;
    const state = { status: 'connected', configurationId: 'config:test', instance: { ref: { instance_id: taskFixture.ref.instance_id } }, deviceSession: { state: 'active', ref: { session_id: 'session:test' } } } as PilotPublicState;
    const client: Pick<MacroPilotNativeClient, 'getState' | 'subscribe' | 'initialize' | 'request'> = {
      getState: () => state, subscribe: () => () => undefined, initialize: async () => state,
      request: (async (_method: string, path: string, _body: unknown, options: { signal?: AbortSignal }) => {
        if (path.endsWith('/disconnect')) return { status: 204, data: null, requestId: 'request:test' };
        polls++;
        await new Promise<void>(resolve => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw Error('Aborted');
      }) as MacroPilotNativeClient['request'],
    };
    const runtime = new PilotRuntime(client, dependencies => new PilotKernel({
      ...dependencies,
      storage: { load: async () => stored, compareAndSwap: async (previous, next) => {
        if (previous !== stored) return false;
        stored = next; return true;
      } },
      project: () => ({ snapshots: [taskFixture as Resource], state: null }),
    }));
    try {
      await runtime.start();
      expect(runtime.getStatus()).toBe('unavailable');
      expect(polls).toBe(0);
      stored = null;
      await runtime.retry();
      expect(runtime.getStatus()).toBe('running');
    } finally { await runtime.stop(); }
  });

});
