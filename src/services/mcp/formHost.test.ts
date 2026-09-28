import { describe, expect, it, mock } from 'bun:test';
import type { McpInteractionRequest, McpInteractionResponse } from '../../types/generated/ipc';
import { McpFormHost, type FormHostPort } from './formHost';

const request = (serverId: string, requestId: string, expiresAtMs = Date.now() + 20_000): McpInteractionRequest => ({
  requestId, operationId: `call-${serverId}`,
  key: { serverId, projectId: null, projectIds: [], configGeneration: 2 },
  expiresAtMs,
  prompts: [{ id: 'p', request: {
    method: 'elicitation/create', params: { mode: 'form', message: 'Display name', requestedSchema: {
      type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
    } },
  } }],
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  let receive: ((request: McpInteractionRequest) => void) | null = null;
  const close = mock(async (_leaseId: string) => undefined);
  const responses: McpInteractionResponse[] = [];
  const active = new Set<string>();
  const open = mock(async (callback: (request: McpInteractionRequest) => void) => {
    receive = callback;
    return 'lease-1';
  });
  const respond = mock(async (_leaseId: string, response: McpInteractionResponse) => {
    responses.push(response);
    active.delete(response.requestId);
  });
  const pending = mock(async (_leaseId: string) => [...active]);
  const port: FormHostPort = { open, close, pending, respond };
  const host = new McpFormHost(port);
  return { host, open, close, pending, active, respond, responses, send: (value: McpInteractionRequest) => {
    active.add(value.requestId);
    receive?.(value);
  } };
}

describe('global MCP form host', () => {
  it('keeps a single lease across StrictMode effect replay and closes it on final unmount', async () => {
    const { host, open, close } = setup();
    const first = host.mount();
    first();
    const second = host.mount();
    await tick();
    expect(host.snapshot().status).toBe('ready');
    expect(open).toHaveBeenCalledTimes(1);
    second();
    await tick();
    expect(close).toHaveBeenCalledWith('lease-1');
    expect(host.snapshot().status).toBe('stopped');
  });

  it('reopens after a real unmount while the previous port is still opening', async () => {
    let resolveFirst: ((leaseId: string) => void) | undefined;
    const firstOpen = new Promise<string>((resolve) => { resolveFirst = resolve; });
    const close = mock(async (_leaseId: string) => undefined);
    let opens = 0;
    const port: FormHostPort = {
      open: async () => (++opens === 1 ? firstOpen : 'lease-2'),
      close,
      pending: async () => [],
      respond: async () => undefined,
    };
    const host = new McpFormHost(port);
    const releaseFirst = host.mount();
    releaseFirst();
    await tick(); // The deferred teardown has run; this is not StrictMode replay.
    expect(host.snapshot().status).toBe('stopped');
    const releaseSecond = host.mount();
    expect(host.snapshot().status).toBe('opening');
    resolveFirst?.('lease-1');
    await tick();
    await tick();
    expect(close).toHaveBeenCalledWith('lease-1');
    expect(opens).toBe(2);
    expect(host.snapshot().status).toBe('ready');
    releaseSecond();
    await tick();
    expect(close).toHaveBeenCalledWith('lease-2');
  });

  it('ignores a request delivered by an old port callback after remount', async () => {
    let resolveFirst: ((leaseId: string) => void) | undefined;
    const firstOpen = new Promise<string>((resolve) => { resolveFirst = resolve; });
    const callbacks: Array<(request: McpInteractionRequest) => void> = [];
    const port: FormHostPort = {
      open: async (callback) => {
        callbacks.push(callback);
        return callbacks.length === 1 ? firstOpen : 'lease-2';
      },
      close: async () => undefined,
      pending: async () => [],
      respond: async () => undefined,
    };
    const host = new McpFormHost(port);
    const releaseFirst = host.mount();
    releaseFirst();
    await tick();
    const releaseSecond = host.mount();
    callbacks[0]?.(request('alpha', 'stale-before-open'));
    resolveFirst?.('lease-1');
    await tick();
    callbacks[0]?.(request('alpha', 'stale-after-open'));
    callbacks[1]?.(request('beta', 'current'));
    expect(host.snapshot().queue.map((item) => item.request.requestId)).toEqual(['current']);
    releaseSecond();
    await tick();
  });

  it('waits for a previous lease to close before reopening after remount', async () => {
    let finishClose: (() => void) | undefined;
    const closePending = new Promise<void>((resolve) => { finishClose = resolve; });
    let opens = 0;
    const callbacks: Array<(request: McpInteractionRequest) => void> = [];
    const port: FormHostPort = {
      open: async (callback) => { callbacks.push(callback); return `lease-${++opens}`; },
      close: async (leaseId) => { if (leaseId === 'lease-1') await closePending; },
      pending: async () => [],
      respond: async () => undefined,
    };
    const host = new McpFormHost(port);
    const releaseFirst = host.mount();
    await tick();
    releaseFirst();
    await tick();
    const releaseSecond = host.mount();
    expect(host.snapshot().status).toBe('opening');
    expect(opens).toBe(1);
    callbacks[0]?.(request('alpha', 'stale-during-close'));
    expect(host.snapshot().queue).toEqual([]);
    finishClose?.();
    await tick();
    expect(opens).toBe(2);
    expect(host.snapshot().status).toBe('ready');
    releaseSecond();
    await tick();
  });

  it('queues requests from different servers and responds using the original session and call', async () => {
    const { host, send, responses } = setup();
    const release = host.mount();
    await tick();
    send(request('alpha', 'one'));
    send(request('beta', 'two'));
    expect(host.snapshot().queue.map((item) => item.request.key.serverId)).toEqual(['alpha', 'beta']);
    expect(host.snapshot().queue[0]?.forms[0]?.message).toBe('Display name');
    expect(await host.answer('one', [{ id: 'p', action: 'accept', content: { name: 'Ada' } }])).toBe(true);
    expect(responses[0]).toMatchObject({
      requestId: 'one', operationId: 'call-alpha', key: { serverId: 'alpha', configGeneration: 2 },
      answers: [{ id: 'p', action: 'accept', content: { name: 'Ada' } }],
    });
    expect(host.snapshot().queue.map((item) => item.request.requestId)).toEqual(['two']);
    expect(await host.answer('two', [{ id: 'p', action: 'cancel', content: null }])).toBe(true);
    expect(host.snapshot().queue).toEqual([]);
    release();
    await tick();
  });

  it('expires queued values and clears them when the port is closed', async () => {
    const { host, send } = setup();
    const release = host.mount();
    await tick();
    send(request('alpha', 'soon', Date.now() + 15));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.snapshot().queue).toEqual([]);
    expect(host.snapshot().issue).toBe('expired');
    send(request('beta', 'later'));
    release();
    await tick();
    expect(host.snapshot().queue).toEqual([]);
    expect(host.snapshot().issue).toBeNull();
  });

  it('drops an externally aborted request while keeping another server queued', async () => {
    const { host, send, active, pending } = setup();
    const release = host.mount();
    await tick();
    send(request('alpha', 'aborted'));
    send(request('beta', 'still-live'));
    active.delete('aborted');
    await host.refreshPending();
    expect(pending).toHaveBeenCalledWith('lease-1');
    expect(host.snapshot().queue.map((item) => item.request.requestId)).toEqual(['still-live']);
    expect(host.snapshot().issue).toBe('cancelled');
    release();
    await tick();
  });

  it('removes a stale operation without sending or retaining another answer', async () => {
    const { host, send, respond } = setup();
    respond.mockImplementationOnce(async () => { throw { code: 'MCP_INTERACTION_STALE', message: 'stale' }; });
    const release = host.mount();
    await tick();
    send(request('alpha', 'stale'));
    expect(await host.answer('stale', [{ id: 'p', action: 'decline', content: null }])).toBe(false);
    expect(host.snapshot().queue).toEqual([]);
    expect(host.snapshot().issue).toBe('cancelled');
    release();
    await tick();
  });
});
