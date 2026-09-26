import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { installReactI18nextMock } from '../test-utils/reactI18nextMock';
import { commandRegistry, executeShortcut, getShortcutAvailability, shortcutHandlers, shortcutRuntimeDefinitions, type CommandContribution, type ShortcutAvailabilityContext, type ShortcutHandlerContext } from './runtime';

installReactI18nextMock();
const savePreference = mock(async () => {});
let stored: Record<string, unknown> = {};
mock.module('../services/preferences', () => ({
  PREF_KEYS: { SHORTCUT_BINDINGS: 'bindings', PROMPT_HISTORY_NAV_MODE: 'history', ACTIVE_TURN_SEND_BEHAVIOR: 'send' },
  loadPreference: async (key: string) => key === 'bindings' ? stored : null,
  savePreference,
}));
const useAppStore = create(() => ({ mode: 'Chat', settingsOpen: true }));
const useChatStore = create(() => ({ selectedConversationId: null, getConversationRuntime: () => ({ phase: 'idle' }) }));
mock.module('../stores/useAppStore', () => ({ useAppStore }));
mock.module('../stores/useChatStore', () => ({ useChatStore }));
const { useShortcutsStore } = await import('../stores/useShortcutsStore');
const { ShortcutsView } = await import('../components/settings/views/ShortcutsView');
const { SettingsSearchProvider } = await import('../components/settings/search/SettingsSearch');
const context: ShortcutAvailabilityContext = {
  editable: false, isChatInputFocused: false, isStreaming: false, mode: 'Chat',
  settingsOpen: true, promptHistoryNavigationMode: 'contextual_arrows',
};
const entry = (id: string, handler = mock(() => true)): CommandContribution => ({
  id, owner: 'test.commands', order: -1,
  definition: { category: 'app', label: id, description: `Description ${id}`, defaultBinding: 'Alt+J' },
  constraints: {}, contextHints: [], handler,
});
// Availability is explicitly supplied; these synthetic handlers need no stores.
const handlerContext = { availability: context, document } as ShortcutHandlerContext;
afterEach(() => commandRegistry.removeOwner('test.commands'));

describe('command contributions', () => {
  it('dispatches synthetic handlers and enforces availability, constraints, activation and removal', () => {
    const handler = mock(() => true);
    const dispose = commandRegistry.register({ ...entry('test.action', handler), available: ({ mode }) => mode === 'Chat', constraints: { settingsOpen: true } });
    expect(executeShortcut('test.action', handlerContext)).toBe(true);
    expect(getShortcutAvailability('test.action', { ...context, mode: 'Architect' }).available).toBe(false);
    expect(getShortcutAvailability('test.action', { ...context, settingsOpen: false }).available).toBe(false);
    commandRegistry.setActive('test.action', false);
    expect(executeShortcut('test.action', handlerContext)).toBe(false);
    commandRegistry.setActive('test.action', true);
    dispose();
    expect(executeShortcut('test.action', handlerContext)).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('enforces activation through historical handler exports too', () => {
    commandRegistry.setActive('app.openSettings', false);
    try {
      expect(shortcutHandlers['app.openSettings'](handlerContext)).toBe(false);
      expect(shortcutRuntimeDefinitions['app.openSettings'].handler(handlerContext)).toBe(false);
    } finally {
      commandRegistry.setActive('app.openSettings', true);
    }
  });

  it('orders deterministically, rejects collisions and protects replacement from stale disposal', () => {
    commandRegistry.register(entry('test.b'));
    const dispose = commandRegistry.register(entry('test.a'));
    expect(commandRegistry.list(context).slice(0, 2).map((command) => command.id)).toEqual(['test.a', 'test.b']);
    expect(() => commandRegistry.register(entry('test.a'))).toThrow('Duplicate contribution');
    commandRegistry.removeOwner('test.commands');
    commandRegistry.register(entry('test.a'));
    dispose();
    expect(commandRegistry.get('test.a', context)).toBeDefined();
  });

  it('preserves stored custom and null bindings across late registration and owner removal', async () => {
    stored = { 'test.saved': 'Alt+K', 'test.disabled': null };
    await useShortcutsStore.getState().initialize();
    commandRegistry.register(entry('test.saved'));
    commandRegistry.register(entry('test.disabled'));
    expect(useShortcutsStore.getState().bindings['test.saved']).toBe('Alt+K');
    expect(useShortcutsStore.getState().bindings['test.disabled']).toBeNull();
    commandRegistry.removeOwner('test.commands');
    commandRegistry.register(entry('test.saved'));
    expect(useShortcutsStore.getState().bindings['test.saved']).toBe('Alt+K');
    useShortcutsStore.getState().resetBinding('test.saved');
    expect(useShortcutsStore.getState().bindings['test.saved']).toBe('Alt+J');
  });

  it('updates the settings UI on registration, availability change, activation and removal', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<SettingsSearchProvider><ShortcutsView /></SettingsSearchProvider>));
      await act(async () => { commandRegistry.register({ ...entry('test.ui'), available: ({ mode }) => mode === 'Chat' }); });
      expect(container.textContent).toContain('Description test.ui');
      await act(async () => useAppStore.setState({ mode: 'Architect' }));
      expect(container.textContent).not.toContain('Description test.ui');
      await act(async () => useAppStore.setState({ mode: 'Chat' }));
      expect(container.textContent).toContain('Description test.ui');
      await act(async () => commandRegistry.setActive('test.ui', false));
      expect(container.textContent).not.toContain('Description test.ui');
      await act(async () => commandRegistry.setActive('test.ui', true));
      expect(container.textContent).toContain('Description test.ui');
      await act(async () => commandRegistry.removeOwner('test.commands'));
      expect(container.textContent).not.toContain('Description test.ui');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
