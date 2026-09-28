import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDeferred } from '../../test-utils/deferred';
import { createTranslationMock, installReactI18nextMock } from '../../test-utils/reactI18nextMock';
import { TOOL_INVOCATIONS_CHANGED_EVENT } from '../../services/ipc/toolInvocations';
import type { ConversationExecutionPhase } from '../../types';
import type { ToolInvocation } from '../../types/generated/ipc';

const list = mock((_conversationId: string): Promise<ToolInvocation[]> => Promise.resolve([]));
let tauriAvailable = true;
let Notice: typeof import('./UnresolvedToolInvocationsNotice').UnresolvedToolInvocationsNotice;
let root: Root;
let container: HTMLDivElement;

const invocation = (status: 'pending' | 'unknown', toolName = 'terminal_run', turnId = 'turn'): ToolInvocation => ({
  conversation_id: 'first', turn_id: turnId, message_id: 'message', call_id: toolName,
  tool_name: toolName, effect_class: 'workspace_mutation', arguments_sha256: 'secret-hash',
  remote_execution_id: null, status, receipt_id: null, created_at: '', updated_at: '',
});

beforeAll(async () => {
  installReactI18nextMock(createTranslationMock({}));
  mock.module('../../services/tauriIpc', () => ({
    isTauriAvailable: () => tauriAvailable,
    listUnresolvedToolInvocations: list,
  }));
  ({ UnresolvedToolInvocationsNotice: Notice } = await import('./UnresolvedToolInvocationsNotice'));
});

beforeEach(() => {
  tauriAvailable = true;
  list.mockReset();
  list.mockImplementation(async () => []);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = async (conversationId: string | null, phase: ConversationExecutionPhase, activeTurnId: string | null = null) => {
  await act(async () => root.render(<Notice conversationId={conversationId} phase={phase} activeTurnId={activeTurnId} />));
};

describe('UnresolvedToolInvocationsNotice', () => {
  it('shows unknown outcomes without sensitive fields or replay controls', async () => {
    list.mockImplementation(async () => [invocation('unknown')]);
    await render('first', 'idle');
    expect(container.textContent).toContain('terminal_run');
    expect(container.textContent).toContain('outcome unknown');
    expect(container.textContent).toContain('Inspect the tool');
    expect(container.textContent).not.toContain('secret-hash');
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps live pending calls hidden and refreshes when the turn ends', async () => {
    const afterTurn = createDeferred<ToolInvocation[]>();
    list.mockImplementationOnce(async () => [invocation('pending')]);
    list.mockImplementationOnce(() => afterTurn.promise);
    await render('first', 'streaming', 'turn');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await render('first', 'idle');
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('pending after turn ended');
    await act(async () => afterTurn.resolve([]));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows inspection in progress when the first pending entry is not yet readable', async () => {
    const afterTurn = createDeferred<ToolInvocation[]>();
    list.mockImplementationOnce(async () => []);
    list.mockImplementationOnce(() => afterTurn.promise);
    await render('first', 'streaming', 'turn');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await render('first', 'idle');
    expect(container.textContent).toContain('Checking local tool effects');
    await act(async () => afterTurn.resolve([invocation('pending')]));
    expect(container.textContent).toContain('pending after turn ended');
  });

  it('keeps a pending reservation hidden while the turn is persisting', async () => {
    list.mockImplementation(async () => [invocation('pending')]);
    await render('first', 'persisting', 'turn');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await render('first', 'idle');
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('pending after turn ended');
  });

  it('keeps an older pending invocation visible during a new turn', async () => {
    list.mockImplementation(async () => [
      invocation('pending', 'old_tool', 'old-turn'),
      invocation('pending', 'current_tool', 'current-turn'),
    ]);
    await render('first', 'streaming', 'current-turn');
    expect(container.textContent).toContain('old_tool');
    expect(container.textContent).not.toContain('current_tool');
  });

  it('refreshes after a journal mutation without a phase change', async () => {
    const refreshed = createDeferred<ToolInvocation[]>();
    list.mockImplementationOnce(async () => [invocation('unknown')]);
    list.mockImplementationOnce(() => refreshed.promise);
    await render('first', 'idle');
    expect(container.textContent).toContain('terminal_run');
    await act(async () => window.dispatchEvent(new CustomEvent(TOOL_INVOCATIONS_CHANGED_EVENT, {
      detail: { conversationId: 'first' },
    })));
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('terminal_run');
    await act(async () => refreshed.resolve([]));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('distinguishes repeated calls to the same tool without showing arguments', async () => {
    const remaining = invocation('unknown', 'write', 'second-turn');
    list.mockImplementationOnce(async () => [invocation('unknown', 'write', 'first-turn'), remaining]);
    list.mockImplementationOnce(async () => [remaining]);
    await render('first', 'idle');
    const calls = Array.from(container.querySelectorAll('li'), (item) => item.textContent);
    expect(calls).toHaveLength(2);
    const firstReference = calls[0]?.match(/#[0-9a-f]{16}/)?.[0];
    const remainingReference = calls[1]?.match(/#[0-9a-f]{16}/)?.[0];
    expect(firstReference).toBeTruthy();
    expect(remainingReference).toBeTruthy();
    expect(firstReference).not.toBe(remainingReference);
    await act(async () => window.dispatchEvent(new CustomEvent(TOOL_INVOCATIONS_CHANGED_EVENT, {
      detail: { conversationId: 'first' },
    })));
    expect(container.querySelector('li')?.textContent).toContain(`${remainingReference} write`);
    expect(container.textContent).not.toContain('secret-hash');
  });

  it('warns when the local journal cannot be read', async () => {
    const afterRetry = createDeferred<ToolInvocation[]>();
    list.mockImplementationOnce(async () => { throw new Error('sensitive SQLite path'); });
    list.mockImplementationOnce(() => afterRetry.promise);
    await render('first', 'idle');
    expect(container.textContent).toContain('Unable to check the local tool journal');
    expect(container.textContent).not.toContain('sensitive SQLite path');
    await act(async () => container.querySelector('button')?.click());
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Unable to check the local tool journal');
    await act(async () => afterRetry.resolve([]));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  for (const [name, malformed] of [
    ['a null response', null],
    ['an object response', {}],
    ['a null entry', [null]],
    ['an entry from another conversation', [{ ...invocation('unknown'), conversation_id: 'second' }]],
  ] as const) {
    it(`treats ${name} as a journal read failure`, async () => {
      list.mockImplementation(async () => malformed as unknown as ToolInvocation[]);
      await render('first', 'idle');
      expect(container.textContent).toContain('Unable to check the local tool journal');
      expect(container.textContent).not.toContain('terminal_run');
    });
  }

  it('discards a late response from the previous conversation', async () => {
    const first = createDeferred<ToolInvocation[]>();
    list.mockImplementation((id) => id === 'first' ? first.promise : Promise.resolve([]));
    await render('first', 'idle');
    await render('second', 'idle');
    await act(async () => first.resolve([invocation('unknown')]));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(list.mock.calls.map(([id]) => id)).toEqual(['first', 'second']);
  });

  it('shows local unknown outcomes with Tauri even when services request remote', async () => {
    const previousTransport = process.env.VITE_BACKEND_TRANSPORT;
    process.env.VITE_BACKEND_TRANSPORT = 'remote';
    try {
      list.mockImplementation(async () => [invocation('unknown')]);
      await render('first', 'idle');
      expect(list).toHaveBeenCalledWith('first');
      expect(container.textContent).toContain('terminal_run');
      expect(container.textContent).toContain('outcome unknown');
    } finally {
      if (previousTransport === undefined) delete process.env.VITE_BACKEND_TRANSPORT;
      else process.env.VITE_BACKEND_TRANSPORT = previousTransport;
    }
  });

  it('does not query SQLite in remote mode without Tauri', async () => {
    tauriAvailable = false;
    const previousTransport = process.env.VITE_BACKEND_TRANSPORT;
    process.env.VITE_BACKEND_TRANSPORT = 'remote';
    try {
      await render('first', 'idle');
      expect(list).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      if (previousTransport === undefined) delete process.env.VITE_BACKEND_TRANSPORT;
      else process.env.VITE_BACKEND_TRANSPORT = previousTransport;
    }
  });
});
