import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useChatStore } from '../../stores/useChatStore';
import {
  applyArchiveViewSelection,
  ConversationArchive,
  resolveArchiveViewSelection,
} from './ConversationArchive';
import { useConversationArchiveStore } from '../../stores/useConversationArchiveStore';

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
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
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
    container?.remove();
    container = null;
    root = null;
    useChatStore.setState(initialChatState, true);
    useConversationArchiveStore.setState({ archivedConversationIds: new Set() });
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
    expect(searchInput?.closest('.h-12')).toBe(header ?? null);
    expect(document.activeElement).toBe(searchInput ?? null);

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
});
