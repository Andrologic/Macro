import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import type { AgentType, AppMode } from '../types';
import { useWorkspaceSessionsStore } from '../stores/useWorkspaceSessionsStore';
import { createModePanelLoader } from '../components/layout/panelLoader';
import { workspaceViews } from './workspaceViews';

const app = create(() => ({
  mode: 'Chat' as AppMode, agentType: 'plan' as AgentType,
  activeArchitectPlanId: null, selectedTaskId: null, selectedGroupId: null, selectedProjectId: null,
  setMode: (mode: AppMode) => { app.setState({ mode }); },
}));
const chat = create(() => ({ selectedConversationIdsByMode: { Chat: 'conversation-a' } }));
mock.module('../stores/useAppStore', () => ({ useAppStore: app }));
mock.module('../stores/useChatStore', () => ({ useChatStore: chat }));
const { useWorkspaceShell } = await import('./useWorkspaceShell');
const { ModeRouter } = await import('../components/layout/ModeRouter');
let current!: ReturnType<typeof useWorkspaceShell>;
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  workspaceViews.removeOwner('test');
  useWorkspaceSessionsStore.setState({ sessions: {} });
});

const Harness = () => {
  const shell = useWorkspaceShell();
  useLayoutEffect(() => { current = shell; });
  return <ModeRouter panel="center" />;
};

describe('live shell composition', () => {
  it('routes newly registered views, restores a session selection, and responds to removal', async () => {
    const loader = createModePanelLoader({
      id: 'test.center', label: 'Test', mode: 'Chat', panel: 'center',
      importComponent: async () => () => <div>Inspector</div>,
    });
    await loader.load();
    const register = (id: 'view.test-a' | 'view.test-b', order: number) => workspaceViews.register({
      id, owner: 'test', order, workspaceId: 'workspace.chat', label: id, labelKey: id, icon: 'layers', panels: { center: loader },
    });
    register('view.test-a', 10);
    register('view.test-b', 11);
    // Hide the built-in just in this test to avoid importing the chat runtime.
    workspaceViews.setActive('view.chat', false);
    try {
      container = document.createElement('div'); document.body.append(container); root = createRoot(container);
      await act(async () => { root?.render(<Harness />); });
      expect(container.textContent).toBe('Inspector');
      act(() => { current.selectView('view.test-b'); });
      const sessionA = current.session.id;
      expect(current.view?.id).toBe('view.test-b');
      act(() => { chat.setState({ selectedConversationIdsByMode: { Chat: 'conversation-b' } }); });
      expect(current.session.id).not.toBe(sessionA);
      expect(current.view?.id).toBe('view.test-a');
      act(() => { chat.setState({ selectedConversationIdsByMode: { Chat: 'conversation-a' } }); });
      expect(current.view?.id).toBe('view.test-b');
      expect(app.getState().mode).toBe('Chat');
      expect(app.getState().agentType).toBe('plan');
      act(() => { workspaceViews.setActive('view.test-b', false); });
      expect(current.view?.id).toBe('view.test-a');
      act(() => { workspaceViews.removeOwner('test'); });
      expect(current.view).toBeUndefined();
      expect(container.textContent).toBe('');
    } finally { act(() => { root?.unmount(); root = undefined; workspaceViews.setActive('view.chat', true); }); }
  });

  it('preserves intentional panel sharing between views in the same session', async () => {
    let mounts = 0;
    const loader = createModePanelLoader({
      id: 'test.shared', label: 'Test', mode: 'Chat', panel: 'center',
      importComponent: async () => function Shared() {
        useLayoutEffect(() => { mounts += 1; }, []);
        return <div>Shared</div>;
      },
    });
    await loader.load();
    for (const id of ['view.test-a', 'view.test-b'] as const) workspaceViews.register({
      id, owner: 'test', order: 0, workspaceId: 'workspace.chat', label: id, labelKey: id, icon: 'layers', panels: { center: loader },
    });
    workspaceViews.setActive('view.chat', false);
    try {
      container = document.createElement('div'); document.body.append(container); root = createRoot(container);
      await act(async () => { root?.render(<Harness />); });
      const sessionId = current.session.id;
      act(() => { current.selectView('view.test-b'); });
      expect(current.session.id).toBe(sessionId);
      expect(mounts).toBe(1);
      act(() => { chat.setState({ selectedConversationIdsByMode: { Chat: 'conversation-isolated' } }); });
      expect(current.session.id).not.toBe(sessionId);
      expect(mounts).toBe(2);
    } finally { act(() => { root?.unmount(); root = undefined; workspaceViews.setActive('view.chat', true); }); }
  });
});
