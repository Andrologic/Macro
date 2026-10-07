import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, useState } from 'react';
import { SettingsModal } from '../settings/SettingsModal';
import { Dialog } from '../ui/Dialog';
import { useAppStore } from '../../stores/useAppStore';
import { settingsRegistry } from '../../composition/settings/registry';
import { useGlobalShortcuts } from '../../hooks/useGlobalShortcuts';
import { createDeferred } from '../../test-utils/deferred';
import { createRoot, type Root } from 'react-dom/client';
import { useChatStore } from '../../stores/useChatStore';
import {
  applyArchiveViewSelection,
  ConversationArchive,
  ConversationItem,
  resolveArchiveViewSelection,
} from './ConversationArchive';
import { useConversationArchiveStore } from '../../stores/useConversationArchiveStore';
import {
  DEFAULT_CHAT_VIEW_FILTERS,
} from '../../services/viewFilterPreferences';
import { useViewFilterStore } from '../../stores/useViewFilterStore';
import { PREF_KEYS, savePreference } from '../../services/preferences';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../../test-utils/tauriRuntime';

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

describe('ConversationArchive', () => {
  const initialChatState = useChatStore.getState();
  const initialAppState = useAppStore.getState();
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  let stateValues: Record<string, unknown> = {};
  let restoreSettingsContribution: (() => void) | undefined;
  let invokeMock = mock(async (
    _command?: string,
    _payload?: Record<string, unknown>,
  ): Promise<unknown> => undefined);

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() { return this.hasAttribute('data-conversation-actions-menu') ? 208 : this.classList.contains('overflow-y-auto') ? 600 : 80; },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 280; } });
    useAppStore.setState({ settingsOpen: false, mode: 'Chat' });
    stateValues = {};
    invokeMock = mock(async (
      command?: string,
      payload?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (command === 'state_get_snapshot') {
        return { schemaVersion: 1, values: structuredClone(stateValues) };
      }
      if (command === 'state_set_value') {
        stateValues[String(payload?.key)] = structuredClone(payload?.value);
        return {
          schemaVersion: 1,
          values: structuredClone(stateValues),
        };
      }
      return undefined;
    });
    installTauriRuntimeMock(invokeMock as never);
    useViewFilterStore.setState({
      chat: { ...DEFAULT_CHAT_VIEW_FILTERS },
      isHydrated: true,
    });
    window.localStorage.setItem('macro_chatArchivedConversationIds', '[]');
    useChatStore.setState({
      ...useChatStore.getState(),
      conversations: [
        {
          id: 'conversation-1',
          title: 'Conversation active',
          scope_mode: 'Chat',
          task_id: null,
          project_id: 'project-1',
          last_message: 'Dernier message',
          message_count: 1,
          updated_at: '2026-08-16T10:00:00.000Z',
          is_unread: false,
        },
      ],
      selectedConversationId: 'conversation-1',
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    restoreSettingsContribution?.();
    restoreSettingsContribution = undefined;
    container?.remove();
    container = null;
    root = null;
    useChatStore.setState(initialChatState, true);
    useAppStore.setState(initialAppState, true);
    useConversationArchiveStore.setState({ archivedConversationIds: new Set() });
    removeTauriRuntimeMock();
    if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', heightDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
    if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
  });

  it.each([false, true])('cleans committed overlapping archives and preserves drafts on failure: %s', async (failSecondWrite) => {
    const active = useChatStore.getState().conversations[0];
    const first = { ...active, id: 'audit-a', title: 'Audit A' };
    const second = { ...active, id: 'audit-b', title: 'Audit B' };
    const writing = createDeferred<void>();
    const release = createDeferred<void>();
    const discard = mock((id: string) => initialChatState.discardComposerDraftForConversation(id));
    useChatStore.setState({
      conversations: [first, second, active],
      discardComposerDraftForConversation: discard,
      composerDraftsByContextKey: {
        'conversation:audit-a': { text: 'Brouillon A', images: [], contextRefs: [] },
        'conversation:audit-b': { text: 'Brouillon B', images: [], contextRefs: [] },
      },
    });
    await act(async () => { root?.render(<ConversationArchive />); await flushRender(); });
    let archiveWrites = 0;
    invokeMock.mockImplementation(async (command, payload) => {
      if (command === 'state_set_value') {
        if (payload?.key === PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS && ++archiveWrites === 1) {
          writing.resolve(); await release.promise;
        }
        if (payload?.key === PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS && archiveWrites === 2 && failSecondWrite) {
          throw new Error('second archive write failed');
        }
        stateValues[String(payload?.key)] = structuredClone(payload?.value);
      }
      return { schemaVersion: 1, values: structuredClone(stateValues) };
    });
    const archive = async (name: string) => {
      const row = Array.from(container!.querySelectorAll('[data-index]')).find((row) => row.textContent?.includes(name));
      expect(row).toBeDefined();
      await act(async () => {
        row?.querySelector<HTMLButtonElement>('[aria-label="Conversation actions"]')?.click();
        await flushRender();
      });
      const command = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[data-conversation-actions-menu] button'))
        .find((button) => button.textContent?.trim() === 'Archive');
      expect(command).toBeDefined();
      await act(async () => { command?.click(); await flushRender(); });
    };
    await archive('Audit A'); await writing.promise;
    await archive('Audit B');
    await act(async () => { release.resolve(); await flushRender(); });
    const expectedArchivedIds = failSecondWrite ? ['audit-a'] : ['audit-a', 'audit-b'];
    expect(stateValues[PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS]).toEqual(expectedArchivedIds);
    expect(Array.from(useConversationArchiveStore.getState().archivedConversationIds)).toEqual(expectedArchivedIds);
    expect(useChatStore.getState().getComposerDraftForContext('conversation:audit-a')).toBeNull();
    if (failSecondWrite) {
      expect(useChatStore.getState().getComposerDraftForContext('conversation:audit-b')?.text).toBe('Brouillon B');
    } else {
      expect(useChatStore.getState().getComposerDraftForContext('conversation:audit-b')).toBeNull();
    }
    expect(discard.mock.calls.map(([id]) => id)).toEqual(expectedArchivedIds);
    expect(useChatStore.getState().selectedConversationId).toBe(active.id);
  });

  it('activates only the focused row and leaves nested keyboard actions alone', async () => {
    const selectConversation = mock(async () => true);
    useChatStore.setState({ selectConversation });
    await act(async () => {
      root?.render(<ConversationItem conversation={useChatStore.getState().conversations[0]}
        isCurrentConversation={false} isRunning={false} isChecked={false} isPinned={false}
        isMultiSelectMode={false} isArchivedView={false}
        onActivate={() => { void selectConversation(); }} onToggleSelection={() => {}}
        onPin={() => {}} onArchiveToggle={() => {}} onDeleteComplete={async () => {}} />);
      await flushRender();
    });
    const row = container?.querySelector<HTMLElement>('[role="button"]');
    const menuButton = row?.querySelector<HTMLButtonElement>('button');
    expect(row).not.toBeNull();
    expect(menuButton).not.toBeNull();
    for (const key of ['Enter', ' ']) {
      const nestedEvent = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      await act(async () => { menuButton?.dispatchEvent(nestedEvent); });
      expect(nestedEvent.defaultPrevented).toBe(false);
      expect(selectConversation).not.toHaveBeenCalled();
    }
    for (const key of ['Enter', ' ']) {
      const rowEvent = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      await act(async () => { row?.dispatchEvent(rowEvent); });
      expect(rowEvent.defaultPrevented).toBe(true);
    }
    expect(selectConversation).toHaveBeenCalledTimes(2);
    await act(async () => { menuButton?.click(); });
    expect(selectConversation).toHaveBeenCalledTimes(2);
    const exportButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[data-conversation-actions-menu] button'))
      .find((button) => button.textContent?.trim() === 'Export JSON');
    expect(exportButton).toBeDefined();
    await act(async () => { row?.click(); });
    expect(selectConversation).toHaveBeenCalledTimes(3);
  });

  it('keeps multi-select compact until the header button activates its toolbar', async () => {
    await act(async () => {
      root?.render(<ConversationArchive />);
      await flushRender();
    });

    const multiSelectButton = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="chat-multiselect"]'
    );
    const newConversationButton = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="chat-new-conversation"]'
    );

    expect(multiSelectButton).not.toBeNull();
    expect(multiSelectButton?.parentElement).toBe(newConversationButton?.parentElement);
    expect(multiSelectButton?.className).toContain('h-7 w-7');
    expect(multiSelectButton?.className).toContain('border');
    expect(newConversationButton?.className).toContain('h-7 w-7');
    expect(newConversationButton?.className).toContain('border');
    expect(newConversationButton?.getAttribute('aria-label')).toBe('New Chat');
    expect(document.body.querySelector('[data-tour-id="chat-multiselect-toolbar"]')).toBeNull();

    await act(async () => {
      multiSelectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    const toolbar = document.body.querySelector('[data-tour-id="chat-multiselect-toolbar"]');
    expect(document.body.querySelector('[data-tour-id="chat-multiselect"]')).toBeNull();
    expect(toolbar?.textContent).toContain('0');
    expect(toolbar?.querySelectorAll('button')).toHaveLength(4);
    expect(toolbar?.querySelector('[aria-label="Select all"] span')?.className).not.toContain('sr-only');
    expect(toolbar?.querySelector('[aria-label="Archive"]')?.className).toContain('h-8 w-8');
    expect(toolbar?.querySelector('[aria-label="Archive"] span')?.className).toContain('sr-only');
    expect(toolbar?.querySelector('[aria-label="Delete"] span')?.className).toContain('sr-only');
    expect(toolbar?.querySelector('[aria-label="Cancel"] span')?.className).toContain('sr-only');
    await act(async () => {
      toolbar?.querySelector<HTMLButtonElement>('[aria-label="Select all"]')?.click();
      await flushRender();
    });
    expect(toolbar?.querySelector<HTMLButtonElement>('[aria-label="Delete"]')?.disabled).toBe(false);
    await act(async () => {
      toolbar?.querySelector<HTMLButtonElement>('[aria-label="Delete"]')?.click();
      await flushRender();
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
        .find((button) => button.textContent?.trim() === 'Cancel')?.click();
      await flushRender();
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      toolbar?.querySelector<HTMLButtonElement>('[aria-label="Cancel"]')?.click();
      await flushRender();
    });
    expect(document.body.querySelector('[data-tour-id="chat-multiselect-toolbar"]')).toBeNull();
  });

  it('shows the archive toggle in the header and switches to the archived view', async () => {
    await act(async () => {
      root?.render(<ConversationArchive />);
      await flushRender();
    });

    const archiveToggle = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="chat-archive-toggle"]'
    );
    const header = archiveToggle?.closest('.h-12.border-b');

    expect(archiveToggle).not.toBeNull();
    expect(header).not.toBeNull();
    expect(archiveToggle?.getAttribute('aria-label')).toBe('Archives');
    expect(archiveToggle?.getAttribute('aria-pressed')).toBe('false');
    expect(document.body.querySelector('.border-t [data-tour-id="chat-archive-toggle"]')).toBeNull();

    await act(async () => {
      archiveToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(archiveToggle?.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('No archived conversations');
  });

  it('aligns the selected conversation with a restored archived view', async () => {
    const selectConversation = mock(async (conversationId: string) => {
      useChatStore.setState({ selectedConversationId: conversationId });
      return true;
    });
    useChatStore.setState({
      conversations: [
        ...useChatStore.getState().conversations,
        {
          id: 'conversation-2',
          title: 'Conversation archivée',
          scope_mode: 'Chat',
          task_id: null,
          project_id: 'project-1',
          last_message: 'Ancien message',
          message_count: 1,
          updated_at: '2026-08-15T10:00:00.000Z',
          is_unread: false,
        },
      ],
      selectedConversationId: 'conversation-1',
      selectConversation: selectConversation as never,
    });
    await savePreference(PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS, ['conversation-2']);
    useConversationArchiveStore.getState().replaceArchivedConversationIds(['conversation-2']);
    useViewFilterStore.setState({
      chat: { version: 1, showArchived: true },
      isHydrated: true,
    });

    await act(async () => {
      root?.render(<ConversationArchive />);
      await flushRender();
    });

    expect(selectConversation).toHaveBeenCalledWith('conversation-2');
    expect(useChatStore.getState().selectedConversationId).toBe('conversation-2');
    expect(
      document.body.querySelector('[data-tour-id="chat-archive-toggle"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    await act(async () => {
      root?.render(<></>);
      useChatStore.setState({ selectedConversationId: 'conversation-1' });
      await flushRender();
    });
    selectConversation.mockClear();
    await act(async () => {
      root?.render(<ConversationArchive />);
      await flushRender();
    });

    expect(selectConversation).toHaveBeenCalledWith('conversation-2');
    expect(useChatStore.getState().selectedConversationId).toBe('conversation-2');
  });

  it('keeps Archives open through asynchronous selection and restores the selected archive', async () => {
    const loading = createDeferred<void>();
    const active = useChatStore.getState().conversations[0];
    const archived = { ...active, id: 'conversation-2', title: 'Conversation archivée' };
    const selectConversation = mock(async (id: string) => {
      useChatStore.setState({ selectedConversationId: id });
      if (id === archived.id) await loading.promise;
      return useChatStore.getState().selectedConversationId === id;
    });
    useChatStore.setState({ conversations: [active, archived], selectConversation });
    await savePreference(PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS, [archived.id]);
    useConversationArchiveStore.getState().replaceArchivedConversationIds([archived.id]);
    await act(async () => {
      root?.render(<ConversationArchive />);
      await flushRender();
    });
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-tour-id="chat-archive-toggle"]')?.click();
      await flushRender();
    });
    expect(selectConversation.mock.calls.map(([id]) => id)).toEqual([archived.id]);
    await act(async () => {
      loading.resolve();
      await flushRender();
    });
    expect(document.body.querySelector('[data-tour-id="chat-archive-toggle"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container?.textContent).toContain(archived.title);
    expect(container?.textContent).not.toContain(active.title);

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="Conversation actions"]')?.click();
      await flushRender();
    });
    const restore = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Restore');
    expect(restore).toBeDefined();
    await act(async () => {
      restore?.click();
      await flushRender();
    });
    expect(useConversationArchiveStore.getState().archivedConversationIds.has(archived.id)).toBe(false);
    expect(useChatStore.getState().selectedConversationId).toBe(archived.id);
    expect(document.body.querySelector('[data-tour-id="chat-archive-toggle"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(stateValues[PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS]).toEqual([]);
  });

  it('renders conversation actions outside virtual rows and invokes Pin with a mouse click', async () => {
    const active = useChatStore.getState().conversations[0];
    const togglePinConversation = mock(async () => true);
    useChatStore.setState({
      conversations: [active, { ...active, id: 'conversation-2', title: 'Deuxième' }, { ...active, id: 'conversation-3', title: 'Troisième' }],
      togglePinConversation,
    });
    await act(async () => {
      root?.render(<ConversationArchive />);
      await flushRender();
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="Conversation actions"]')?.click();
      await flushRender();
    });
    const pin = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Pin');
    expect(pin).toBeDefined();
    expect(pin?.closest('[data-index]')).toBeNull();
    expect(container?.contains(pin!)).toBe(false);
    await act(async () => { pin?.click(); await flushRender(); });
    expect(togglePinConversation).toHaveBeenCalledWith(active.id);
    expect(document.body.querySelector('[data-conversation-actions-menu]')).toBeNull();
  });

  it.each([false, true])('closes the portal for Mod+, Settings and restores keyboard focus, menu focused: %s', async (focusMenu) => {
    removeTauriRuntimeMock();
    // Exercise the real Settings shell and Dialog without loading unrelated settings services.
    const general = settingsRegistry.get('general', { settingsOpen: true })!;
    settingsRegistry.setActive('general', false);
    const unregister = settingsRegistry.register({
      ...general, id: 'history-test', owner: 'test.history', order: -1, load: undefined,
      component: () => <button>Settings control</button>,
    });
    restoreSettingsContribution = () => { unregister(); settingsRegistry.setActive('general', true); };
    const Scene = () => {
      useGlobalShortcuts();
      return <><ConversationArchive /><SettingsModal /></>;
    };
    await act(async () => { root?.render(<Scene />); await flushRender(); });
    const trigger = container!.querySelector<HTMLButtonElement>('[aria-label="Conversation actions"]')!;
    await act(async () => { trigger.focus(); trigger.click(); await flushRender(); });
    const menu = document.body.querySelector<HTMLElement>('[data-conversation-actions-menu]')!;
    const backdrop = menu.previousElementSibling!;
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toContain('z-[80]');
    if (focusMenu) menu.querySelector<HTMLButtonElement>('button')!.focus();
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
        key: ',', bubbles: true, cancelable: true,
        metaKey: navigator.platform.toLowerCase().includes('mac'),
        ctrlKey: !navigator.platform.toLowerCase().includes('mac'),
      }));
      await flushRender();
    });
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(dialog).not.toBeNull();
    expect(menu.isConnected).toBe(false);
    expect(backdrop.isConnected).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await flushRender();
    });
    await act(async () => { await flushRender(); });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement === trigger).toBe(true);
    await act(async () => { trigger.click(); await flushRender(); });
    document.body.querySelector<HTMLButtonElement>('[data-conversation-actions-menu] button')!.focus();
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await flushRender();
    });
    expect(document.body.querySelector('[data-conversation-actions-menu]')).toBeNull();
    expect(document.activeElement === trigger).toBe(true);
  });

  it('restores a closed menu trigger after the application background stops being inert', async () => {
    await act(async () => { root?.render(<ConversationArchive />); await flushRender(); });
    const trigger = container!.querySelector<HTMLButtonElement>('[aria-label="Conversation actions"]')!;
    await act(async () => { trigger.focus(); trigger.click(); await flushRender(); });
    document.body.querySelector<HTMLButtonElement>('[data-conversation-actions-menu] button')!.focus();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    const control = document.createElement('button'); dialog.appendChild(control);
    await act(async () => {
      container!.setAttribute('inert', ''); document.body.appendChild(dialog); control.focus();
      await flushRender();
    });
    expect(document.body.querySelector('[data-conversation-actions-menu]')).toBeNull();
    await act(async () => { dialog.remove(); await flushRender(); });
    expect(container!.hasAttribute('inert')).toBe(true);
    expect(document.activeElement === trigger).toBe(false);
    await act(async () => { container!.removeAttribute('inert'); await flushRender(); });
    expect(document.activeElement === trigger).toBe(true);
  });

  it('closes actions for any Dialog without stealing its initial or restored focus', async () => {
    const Scene = () => {
      const [open, setOpen] = useState(false);
      return <><ConversationArchive /><button onClick={() => setOpen(true)}>Open dialog</button>
        {open && <Dialog title="Other dialog" onClose={() => setOpen(false)}><button>Dialog action</button></Dialog>}
      </>;
    };
    await act(async () => { root?.render(<Scene />); await flushRender(); });
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[aria-label="Conversation actions"]')!.click();
      await flushRender();
    });
    const opener = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent === 'Open dialog')!;
    await act(async () => { opener.focus(); opener.click(); await flushRender(); });
    expect(document.body.querySelector('[data-conversation-actions-menu]')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Dialog action');
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await flushRender();
    });
    expect(document.activeElement === opener).toBe(true);
  });

  it('returns from Archives to the previous active conversation without a competing selection', async () => {
    const active = useChatStore.getState().conversations[0];
    const archived = { ...active, id: 'conversation-2', title: 'Archive' };
    const loading = createDeferred<void>();
    const selectConversation = mock(async (id: string) => {
      useChatStore.setState({ selectedConversationId: id });
      if (id === active.id) await loading.promise;
      return useChatStore.getState().selectedConversationId === id;
    });
    useChatStore.setState({ conversations: [active, archived], selectConversation });
    await savePreference(PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS, [archived.id]);
    useConversationArchiveStore.getState().replaceArchivedConversationIds([archived.id]);
    await act(async () => { root?.render(<ConversationArchive />); await flushRender(); });
    const toggle = container?.querySelector<HTMLButtonElement>('[data-tour-id="chat-archive-toggle"]');
    await act(async () => { toggle?.click(); await flushRender(); });
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    selectConversation.mockClear();
    await act(async () => { toggle?.click(); await flushRender(); });
    expect(selectConversation.mock.calls.map(([id]) => id)).toEqual([active.id]);
    await act(async () => { loading.resolve(); await flushRender(); });
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(useChatStore.getState().selectedConversationId).toBe(active.id);
  });

  it('keeps a restored conversation archived when preference persistence fails', async () => {
    const active = useChatStore.getState().conversations[0];
    const archived = { ...active, id: 'conversation-2', title: 'Archive' };
    useChatStore.setState({
      conversations: [active, archived],
      selectedConversationId: archived.id,
      selectConversation: mock(async (id: string) => { useChatStore.setState({ selectedConversationId: id }); return true; }),
    });
    await savePreference(PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS, [archived.id]);
    useConversationArchiveStore.getState().replaceArchivedConversationIds([archived.id]);
    useViewFilterStore.setState({ chat: { version: 1, showArchived: true } });
    await act(async () => { root?.render(<ConversationArchive />); await flushRender(); });
    invokeMock.mockImplementation(async (command, payload) => {
      if (command === 'state_set_value' && payload?.key === PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS) throw new Error('write failed');
      return { schemaVersion: 1, values: structuredClone(stateValues) };
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="Conversation actions"]')?.click();
      await flushRender();
    });
    const restore = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === 'Restore');
    await act(async () => { restore?.click(); await flushRender(); });
    expect(useConversationArchiveStore.getState().archivedConversationIds.has(archived.id)).toBe(true);
    expect(useChatStore.getState().selectedConversationId).toBe(archived.id);
    expect(useViewFilterStore.getState().chat.showArchived).toBe(true);
    expect(stateValues[PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS]).toEqual([archived.id]);
  });

  it('preserves a newer archive selection while a restoration write is pending', async () => {
    const active = useChatStore.getState().conversations[0];
    const archived = { ...active, id: 'conversation-2', title: 'Archive A' };
    const other = { ...active, id: 'conversation-3', title: 'Archive B' };
    const writing = createDeferred<void>();
    const release = createDeferred<void>();
    useChatStore.setState({
      conversations: [active, archived, other],
      selectedConversationId: archived.id,
      selectConversation: mock(async (id: string) => { useChatStore.setState({ selectedConversationId: id }); return true; }),
    });
    await savePreference(PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS, [archived.id, other.id]);
    useConversationArchiveStore.getState().replaceArchivedConversationIds([archived.id, other.id]);
    useViewFilterStore.setState({ chat: { version: 1, showArchived: true } });
    await act(async () => { root?.render(<ConversationArchive />); await flushRender(); });
    invokeMock.mockImplementation(async (command, payload) => {
      if (command === 'state_set_value') {
        if (payload?.key === PREF_KEYS.CHAT_ARCHIVED_CONVERSATION_IDS) {
          writing.resolve();
          await release.promise;
        }
        stateValues[String(payload?.key)] = structuredClone(payload?.value);
      }
      return { schemaVersion: 1, values: structuredClone(stateValues) };
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="Conversation actions"]')?.click();
      await flushRender();
    });
    const restore = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === 'Restore');
    await act(async () => { restore?.click(); await writing.promise; await flushRender(); });
    await act(async () => { await useChatStore.getState().selectConversation(other.id); await flushRender(); });
    await act(async () => { release.resolve(); await flushRender(); });
    expect(useChatStore.getState().selectedConversationId).toBe(other.id);
    expect(useViewFilterStore.getState().chat.showArchived).toBe(true);
    expect(Array.from(useConversationArchiveStore.getState().archivedConversationIds)).toEqual([other.id]);
  });

  it('opens and closes search inside the existing compact header', async () => {
    await act(async () => {
      root?.render(<ConversationArchive />);
      await flushRender();
    });

    expect(document.body.querySelector('[data-tour-id="chat-conversation-search"]')).toBeNull();
    const searchToggle = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="chat-search-toggle"]'
    );
    const header = searchToggle?.closest('.h-12');
    expect(searchToggle?.className).toContain('h-7 w-7');

    await act(async () => {
      searchToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    const searchInput = document.body.querySelector<HTMLInputElement>(
      '[data-tour-id="chat-conversation-search"] input'
    );
    const openSearchToggle = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="chat-search-toggle"]'
    );
    const searchBar = document.body.querySelector<HTMLElement>(
      '[data-tour-id="chat-conversation-search"]'
    );
    expect(searchInput?.closest('.h-12')).toBe(header ?? null);
    expect(document.activeElement).toBe(searchInput ?? null);
    expect(header?.className).toContain('gap-2');
    expect(openSearchToggle?.className).toContain('h-8 w-8');
    expect(searchBar?.className).toContain('focus-within:border-border');
    expect(searchBar?.className).toContain('focus-within:ring-0');

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-tour-id="chat-search-toggle"]')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });
    expect(document.body.querySelector('[data-tour-id="chat-conversation-search"]')).toBeNull();
    expect(header?.className).toContain('h-12');
  });

  it('selects the first archived conversation and restores the previous active selection', () => {
    const conversations = [{ id: 'conversation-1' }, { id: 'conversation-2' }];
    const archivedIds = new Set(['conversation-2']);
    expect(resolveArchiveViewSelection({
      enteringArchive: true,
      conversations,
      archivedIds,
      previousActiveConversationId: 'conversation-1',
    })).toBe('conversation-2');
    expect(resolveArchiveViewSelection({
      enteringArchive: false,
      conversations,
      archivedIds,
      previousActiveConversationId: 'conversation-1',
    })).toBe('conversation-1');
  });

  it('does not validate an archive view switch when conversation selection fails', async () => {
    let cleared = false;
    const selected = await applyArchiveViewSelection(
      'conversation-2',
      async () => false,
      () => {
        cleared = true;
      }
    );

    expect(selected).toBe(false);
    expect(cleared).toBe(false);
  });

  it('selects a conversation search result with the existing list action', async () => {
    const selectConversation = mock(async () => true);
    const selected = await applyArchiveViewSelection(
      'conversation-1',
      selectConversation,
      () => undefined,
    );

    expect(selected).toBe(true);
    expect(selectConversation).toHaveBeenCalledWith('conversation-1');
  });

  it('opens an indexed message result and focuses the message after loading its conversation', async () => {
    invokeMock = mock(async (
      command?: string,
      payload?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (command === 'state_get_snapshot') {
        return { schemaVersion: 1, values: structuredClone(stateValues) };
      }
      if (command === 'state_set_value') {
        stateValues[String(payload?.key)] = structuredClone(payload?.value);
        return {
          schemaVersion: 1,
          values: structuredClone(stateValues),
        };
      }
      if (command === 'db_search_messages') {
        return {
          results: [{
            messageId: 'message-not-loaded',
            conversationId: 'conversation-1',
            conversationTitle: 'Conversation active',
            conversationDescription: null,
            role: 'user',
            snippet: 'Indexed needle in the transcript',
            createdAt: '2026-08-16T10:00:00.000Z',
          }],
          nextOffset: null,
        };
      }
      return undefined;
    });
    installTauriRuntimeMock(invokeMock as never);
    const selectConversation = mock(async () => true);
    useChatStore.setState({ selectConversation: selectConversation as never });
    const focusedMessages: string[] = [];
    const focusListener = (event: Event) => {
      focusedMessages.push((event as CustomEvent<{ messageId: string }>).detail.messageId);
    };
    window.addEventListener('macro:focus-message', focusListener);

    await act(async () => {
      root?.render(<ConversationArchive />);
      await flushRender();
    });
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-tour-id="chat-search-toggle"]')
        ?.click();
      await flushRender();
    });
    const input = document.body.querySelector<HTMLInputElement>(
      '[data-tour-id="chat-conversation-search"] input',
    );
    const propsKey = Object.keys(input ?? {}).find((key) => key.startsWith('__reactProps$'));
    const inputProps = (input as unknown as Record<string, { onChange?: (event: unknown) => void }>)[propsKey!];
    await act(async () => {
      inputProps.onChange?.({ target: { value: 'needle' } });
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await flushRender();
    });

    const result = document.body.querySelector<HTMLButtonElement>(
      '[data-message-search-result="message-not-loaded"]',
    );
    expect(invokeMock.mock.calls.some((call) => call[0] === 'db_search_messages')).toBe(true);
    expect(invokeMock.mock.calls.find((call) => call[0] === 'db_search_messages')?.[1]).toMatchObject({
      conversationIds: ['conversation-1'],
      query: 'needle',
      limit: 25,
      offset: 0,
    });
    expect(result?.textContent).toContain('Indexed needle');
    await act(async () => {
      result?.click();
      await flushRender();
    });
    expect(selectConversation).toHaveBeenCalledWith('conversation-1');
    expect(focusedMessages).toEqual(['message-not-loaded']);
    window.removeEventListener('macro:focus-message', focusListener);
  });
});
