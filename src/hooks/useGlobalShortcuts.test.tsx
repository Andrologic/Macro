import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shortcutDefinitions, type ShortcutId } from '../shortcuts/catalog';
import { shortcutHandlers, shortcutRuntimeDefinitions } from '../shortcuts/runtime';

type StoreHook<T extends object> = ((selector?: (state: T) => unknown) => unknown) & {
  emit: () => void;
  getState: () => T;
  setState: (nextState: Partial<T>) => void;
};

const createStoreHook = <T extends object>(getSnapshot: () => T, setSnapshot: (next: T) => void): StoreHook<T> => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const hook = ((selector?: (state: T) => unknown) => {
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return selector ? selector(snapshot) : snapshot;
  }) as StoreHook<T>;
  hook.emit = () => listeners.forEach((listener) => listener());
  hook.getState = getSnapshot;
  hook.setState = (nextState) => {
    setSnapshot({ ...getSnapshot(), ...nextState });
    hook.emit();
  };
  return hook;
};

type ShortcutsState = {
  bindings: Record<string, string | null>;
  promptHistoryNavigationMode: 'contextual_arrows' | 'shortcut_only';
};

type AppState = {
  settingsOpen: boolean;
  mode: 'Architect' | 'Implement' | 'Chat';
  isLeftPanelOpen: boolean;
  isRightPanelOpen: boolean;
  openSettings: ReturnType<typeof mock>;
  closeSettings: ReturnType<typeof mock>;
  setMode: ReturnType<typeof mock>;
  setLeftPanelOpen: ReturnType<typeof mock>;
  setRightPanelOpen: ReturnType<typeof mock>;
};

type ChatState = {
  selectedConversationId: string | null;
  createConversation: ReturnType<typeof mock>;
  stopStreaming: ReturnType<typeof mock>;
  getConversationRuntime: ReturnType<typeof mock>;
};

type ProviderState = {
  cycleProvider: ReturnType<typeof mock>;
  cycleModel: ReturnType<typeof mock>;
};

let shortcutsState: ShortcutsState;
let appState: AppState;
let chatState: ChatState;
let providerState: ProviderState;

const useShortcutsStore = createStoreHook(() => shortcutsState, (next) => {
  shortcutsState = next;
});
const useAppStore = createStoreHook(() => appState, (next) => {
  appState = next;
});
const useChatStore = createStoreHook(() => chatState, (next) => {
  chatState = next;
});
const useProviderStore = createStoreHook(() => providerState, (next) => {
  providerState = next;
});

mock.module('../stores/useShortcutsStore', () => ({ useShortcutsStore }));
mock.module('../stores/useAppStore', () => ({ useAppStore }));
mock.module('../stores/useChatStore', () => ({ useChatStore }));
mock.module('../stores/useProviderStore', () => ({ useProviderStore }));

describe('useGlobalShortcuts', () => {
  let root: Root | null;
  let container: HTMLDivElement | null;
  let useGlobalShortcuts: typeof import('./useGlobalShortcuts').useGlobalShortcuts;
  let promptHistoryDirections: string[];
  let cleanupPromptHistoryListener: (() => void) | null;

  const renderHook = async () => {
    const TestComponent = () => {
      useGlobalShortcuts();
      return null;
    };
    await act(async () => {
      root?.render(<TestComponent />);
    });
  };

  const buildDefaultBindings = (): Record<string, string | null> =>
    Object.fromEntries(
      shortcutDefinitions.map((definition) => [definition.id, definition.defaultBinding])
    );

  const isMac = () => navigator.platform.toLowerCase().includes('mac');

  const eventInitForBinding = (binding: string): KeyboardEventInit => {
    const parts = binding.split('+');
    const keyToken = parts[parts.length - 1];
    const init: KeyboardEventInit = {
      key: keyToken === 'Space' ? ' ' : keyToken,
      bubbles: true,
      cancelable: true,
    };

    parts.slice(0, -1).forEach((part) => {
      if (part === 'Mod') {
        if (isMac()) {
          init.metaKey = true;
        } else {
          init.ctrlKey = true;
        }
      }
      if (part === 'Ctrl') init.ctrlKey = true;
      if (part === 'Meta') init.metaKey = true;
      if (part === 'Alt') init.altKey = true;
      if (part === 'Shift') init.shiftKey = true;
    });

    return init;
  };

  const dispatchBinding = async (
    binding: string,
    target: EventTarget = window,
    overrides: KeyboardEventInit = {}
  ): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', {
      ...eventInitForBinding(binding),
      ...overrides,
    });
    await act(async () => {
      target.dispatchEvent(event);
      await Promise.resolve();
    });
    return event;
  };

  const dispatchShortcut = async (
    shortcutId: ShortcutId,
    target: EventTarget = window
  ): Promise<KeyboardEvent> => {
    const binding = shortcutsState.bindings[shortcutId];
    if (!binding) {
      throw new Error(`Shortcut ${shortcutId} has no configured binding`);
    }
    return dispatchBinding(binding, target);
  };

  const focusChatInput = () => {
    const input = document.createElement('textarea');
    input.setAttribute('data-shortcut-chat-input', 'true');
    document.body.appendChild(input);
    input.focus();
    return input;
  };

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    shortcutsState = {
      bindings: buildDefaultBindings(),
      promptHistoryNavigationMode: 'contextual_arrows',
    };
    appState = {
      settingsOpen: false,
      mode: 'Chat',
      isLeftPanelOpen: true,
      isRightPanelOpen: true,
      openSettings: mock(() => undefined),
      closeSettings: mock(() => undefined),
      setMode: mock(() => undefined),
      setLeftPanelOpen: mock(() => undefined),
      setRightPanelOpen: mock(() => undefined),
    };
    chatState = {
      selectedConversationId: 'conv-1',
      createConversation: mock(async () => undefined),
      stopStreaming: mock(() => undefined),
      getConversationRuntime: mock(() => ({ phase: 'idle' })),
    };
    providerState = {
      cycleProvider: mock(() => undefined),
      cycleModel: mock(() => undefined),
    };
    promptHistoryDirections = [];
    const handlePromptHistory = (event: Event) => {
      const customEvent = event as CustomEvent<{ direction?: string }>;
      if (customEvent.detail?.direction) {
        promptHistoryDirections.push(customEvent.detail.direction);
      }
    };
    window.addEventListener('macro:prompt-history', handlePromptHistory as EventListener);
    cleanupPromptHistoryListener = () => {
      window.removeEventListener('macro:prompt-history', handlePromptHistory as EventListener);
    };

    ({ useGlobalShortcuts } = await import(`./useGlobalShortcuts.ts?global-shortcuts-test=${Date.now()}`));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    cleanupPromptHistoryListener?.();
    cleanupPromptHistoryListener = null;
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    document.body.innerHTML = '';
  });

  it('defines runtime metadata and handlers for every configurable shortcut', () => {
    const ids = shortcutDefinitions.map((definition) => definition.id).sort();

    expect(Object.keys(shortcutRuntimeDefinitions).sort()).toEqual(ids);
    expect(Object.keys(shortcutHandlers).sort()).toEqual(ids);
  });

  it('opens general settings with the desktop-standard settings shortcut', async () => {
    await renderHook();

    const event = await dispatchShortcut('app.openSettings');

    expect(event.defaultPrevented).toBe(true);
    expect(appState.openSettings.mock.calls).toEqual([[]]);
  });

  it('closes settings when settings are open', async () => {
    appState.settingsOpen = true;
    await renderHook();

    const event = await dispatchShortcut('app.closeSettings');

    expect(event.defaultPrevented).toBe(true);
    expect(appState.closeSettings.mock.calls).toHaveLength(1);
  });

  it('creates a new chat conversation in Chat mode', async () => {
    await renderHook();

    const event = await dispatchShortcut('chat.newConversation');

    expect(event.defaultPrevented).toBe(true);
    expect(chatState.createConversation.mock.calls).toEqual([
      ['New Conversation', null, null],
    ]);
  });

  it('switches to each configured app mode', async () => {
    await renderHook();

    await dispatchShortcut('app.switchMode.architect');
    await dispatchShortcut('app.switchMode.implement');
    await dispatchShortcut('app.switchMode.chat');

    expect(appState.setMode.mock.calls).toEqual([
      ['Architect'],
      ['Implement'],
      ['Chat'],
    ]);
  });

  it('toggles the left and right panels', async () => {
    await renderHook();

    await dispatchShortcut('app.toggleLeftPanel');
    await dispatchShortcut('app.toggleRightPanel');

    expect(appState.setLeftPanelOpen.mock.calls).toEqual([[false]]);
    expect(appState.setRightPanelOpen.mock.calls).toEqual([[false]]);
  });

  it('executes customized bindings from shortcut settings', async () => {
    shortcutsState = {
      ...shortcutsState,
      bindings: {
        ...shortcutsState.bindings,
        'app.toggleLeftPanel': 'Alt+L',
      },
    };
    await renderHook();

    await dispatchBinding('Alt+L');

    expect(appState.setLeftPanelOpen.mock.calls).toEqual([[false]]);
  });

  it('cycles provider and model selections', async () => {
    await renderHook();

    await dispatchShortcut('ai.cycleProvider');
    await dispatchShortcut('ai.cycleModel');

    expect(providerState.cycleProvider.mock.calls).toHaveLength(1);
    expect(providerState.cycleModel.mock.calls).toHaveLength(1);
  });

  it('stops the active stream only when the selected conversation is streaming', async () => {
    chatState.getConversationRuntime = mock(() => ({ phase: 'streaming' }));
    await renderHook();

    const event = await dispatchShortcut('chat.stopStreaming');

    expect(event.defaultPrevented).toBe(true);
    expect(chatState.stopStreaming.mock.calls).toHaveLength(1);
  });

  it('focuses the chat composer input', async () => {
    const input = document.createElement('textarea');
    input.setAttribute('data-shortcut-chat-input', 'true');
    document.body.appendChild(input);
    await renderHook();

    const event = await dispatchShortcut('chat.focusInput');

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('dispatches dedicated prompt history shortcuts in shortcut-only mode when composer is focused', async () => {
    shortcutsState = {
      ...shortcutsState,
      promptHistoryNavigationMode: 'shortcut_only',
    };
    const input = focusChatInput();
    await renderHook();

    await dispatchShortcut('chat.historyPrevious', input);
    await dispatchShortcut('chat.historyNext', input);

    expect(promptHistoryDirections).toEqual(['up', 'down']);
  });

  it('does not execute a shortcut with no configured binding', async () => {
    shortcutsState = {
      ...shortcutsState,
      bindings: {
        ...shortcutsState.bindings,
        'app.openSettings': null,
      },
    };
    await renderHook();

    const event = await dispatchBinding('Mod+,');

    expect(event.defaultPrevented).toBe(false);
    expect(appState.openSettings.mock.calls).toHaveLength(0);
  });

  it('does not execute repeated keydown events', async () => {
    await renderHook();

    const event = await dispatchBinding('Mod+,', window, { repeat: true });

    expect(event.defaultPrevented).toBe(false);
    expect(appState.openSettings.mock.calls).toHaveLength(0);
  });

  it('suspends application shortcuts while an aria-modal dialog is open', async () => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    await renderHook();

    const event = await dispatchShortcut('app.openSettings');

    expect(event.defaultPrevented).toBe(false);
    expect(appState.openSettings.mock.calls).toHaveLength(0);
  });

  it('does not execute non-editable shortcuts from editable fields', async () => {
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();
    await renderHook();

    const event = await dispatchShortcut('chat.newConversation', input);

    expect(event.defaultPrevented).toBe(false);
    expect(chatState.createConversation.mock.calls).toHaveLength(0);
  });

  it('allows explicitly editable shortcuts from editable fields', async () => {
    appState.settingsOpen = true;
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();
    await renderHook();

    const event = await dispatchShortcut('app.closeSettings', input);

    expect(event.defaultPrevented).toBe(true);
    expect(appState.closeSettings.mock.calls).toHaveLength(1);
  });

  it('does not switch modes while settings are open', async () => {
    appState.settingsOpen = true;
    await renderHook();

    const event = await dispatchShortcut('app.switchMode.architect');

    expect(event.defaultPrevented).toBe(false);
    expect(appState.setMode.mock.calls).toHaveLength(0);
  });

  it('does not create a chat conversation outside Chat mode', async () => {
    appState.mode = 'Architect';
    await renderHook();

    const event = await dispatchShortcut('chat.newConversation');

    expect(event.defaultPrevented).toBe(false);
    expect(chatState.createConversation.mock.calls).toHaveLength(0);
  });

  it('does not stop streaming when the selected conversation is idle', async () => {
    await renderHook();

    const event = await dispatchShortcut('chat.stopStreaming');

    expect(event.defaultPrevented).toBe(false);
    expect(chatState.stopStreaming.mock.calls).toHaveLength(0);
  });

  it('does not dispatch dedicated prompt history shortcuts in contextual arrow mode', async () => {
    const input = focusChatInput();
    await renderHook();

    const event = await dispatchShortcut('chat.historyPrevious', input);

    expect(event.defaultPrevented).toBe(false);
    expect(promptHistoryDirections).toEqual([]);
  });

  it('does not dispatch dedicated prompt history shortcuts when composer is not focused', async () => {
    shortcutsState = {
      ...shortcutsState,
      promptHistoryNavigationMode: 'shortcut_only',
    };
    await renderHook();

    const event = await dispatchShortcut('chat.historyPrevious');

    expect(event.defaultPrevented).toBe(false);
    expect(promptHistoryDirections).toEqual([]);
  });
});
