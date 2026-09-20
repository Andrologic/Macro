import { expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { commandRegistry } from '../shortcuts/runtime';

const app = create(() => ({ mode: 'Chat', settingsOpen: false }));
const chat = create(() => ({ selectedConversationId: null, getConversationRuntime: () => ({ phase: 'idle' }) }));
const shortcuts = create(() => ({ bindings: { 'chat.secondarySend': 'Alt+J' as string | null }, promptHistoryNavigationMode: 'contextual_arrows' }));
mock.module('../stores/useAppStore', () => ({ useAppStore: app }));
mock.module('../stores/useChatStore', () => ({ useChatStore: chat }));
mock.module('../stores/useShortcutsStore', () => ({ useShortcutsStore: shortcuts }));
const { useShortcutBinding } = await import('./useShortcutBinding');

it('updates shortcut hints on activation and keeps user bindings intact', async () => {
  const View = () => <span>{useShortcutBinding('chat.secondarySend') ?? 'none'}</span>;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<View />); });
    expect(container.textContent).toBe('Alt+J');
    act(() => { commandRegistry.setActive('chat.secondarySend', false); });
    expect(container.textContent).toBe('none');
    expect(shortcuts.getState().bindings['chat.secondarySend']).toBe('Alt+J');
    act(() => { commandRegistry.setActive('chat.secondarySend', true); });
    expect(container.textContent).toBe('Alt+J');
    act(() => { shortcuts.setState({ bindings: { 'chat.secondarySend': null } }); });
    expect(container.textContent).toBe('none');
  } finally {
    act(() => { root.unmount(); commandRegistry.setActive('chat.secondarySend', true); });
    container.remove();
  }
});
