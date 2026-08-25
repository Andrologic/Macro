import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useChatStore } from '../../stores/useChatStore';
import { ConversationArchive } from './ConversationArchive';

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
    expect(document.body.querySelector('[data-tour-id="chat-multiselect-toolbar"]')).toBeNull();

    await act(async () => {
      multiSelectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    const toolbar = document.body.querySelector('[data-tour-id="chat-multiselect-toolbar"]');
    expect(document.body.querySelector('[data-tour-id="chat-multiselect"]')).toBeNull();
    expect(toolbar?.textContent).toContain('0');
    expect(toolbar?.querySelectorAll('button')).toHaveLength(4);
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
});
