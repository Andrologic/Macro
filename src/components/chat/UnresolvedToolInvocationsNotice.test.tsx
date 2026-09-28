import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDeferred } from '../../test-utils/deferred';
import { createTranslationMock, installReactI18nextMock } from '../../test-utils/reactI18nextMock';
import type { ToolInvocation } from '../../types/generated/ipc';

const list = mock((_conversationId: string): Promise<ToolInvocation[]> => Promise.resolve([]));
let tauriAvailable = true;
let Notice: typeof import('./UnresolvedToolInvocationsNotice').UnresolvedToolInvocationsNotice;
let root: Root;
let container: HTMLDivElement;

const invocation = (status: 'pending' | 'unknown', toolName = 'terminal_run'): ToolInvocation => ({
  conversation_id: 'first', turn_id: 'turn', message_id: 'message', call_id: toolName,
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

const render = async (conversationId: string | null, phase: string) => {
  await act(async () => root.render(<Notice conversationId={conversationId} phase={phase} />));
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
    await render('first', 'streaming');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await render('first', 'idle');
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => afterTurn.resolve([invocation('pending')]));
    expect(container.textContent).toContain('pending after turn ended');
  });

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
