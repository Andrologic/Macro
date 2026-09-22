import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import type { Conversation } from '../../types';
import { usePersistenceHealth } from '../../services/persistenceHealth';
import { createTranslationMock, installReactI18nextMock } from '../../test-utils/reactI18nextMock';

installReactI18nextMock(createTranslationMock({
  'backup.recovery': 'Recovery required. Original data preserved.',
  'backup.diagnostics': 'Diagnostics',
  'chat.queueRecoveryTitle': 'Queued messages need attention',
  'chat.queueRecoveryDescription': '{{count}} queued message(s) are retained. Retry resumes them in their original context.',
  'common.retry': 'Retry',
}));

const openSettingsMock = mock(() => undefined);
const appState = { inAppNotificationsEnabled: false, openSettings: openSettingsMock };
// Simulate the notification service dropping in-app notifications when the preference is off.
const notifyActionRequiredMock = mock(() => undefined);

type ChatTestState = {
  conversations: Conversation[];
  queuedSubmissionRecoveryByConversationId: Record<string, { count: number; error?: string }>;
  retryQueuedSubmissions: (conversationId: string) => Promise<void>;
};

const useChatStore = create<ChatTestState>(() => ({
  conversations: [],
  queuedSubmissionRecoveryByConversationId: {},
  retryQueuedSubmissions: async () => undefined,
}));

mock.module('../../stores/useChatStore', () => ({ useChatStore }));
mock.module('../../stores/useAppStore', () => ({
  useAppStore: { getState: () => appState },
}));
mock.module('../ui/toastService', () => ({
  notify: { actionRequired: notifyActionRequiredMock },
}));

const { Dialog } = await import('../ui/Dialog');
const { PersistenceHealthNotifications } = await import('./PersistenceHealthNotifications');

const conversation: Conversation = {
  id: 'conversation-1',
  title: 'Recovery conversation',
  scope_mode: 'Chat',
  task_id: null,
  project_id: 'project-1',
  last_message: '',
  message_count: 0,
  updated_at: '2026-09-22T10:00:00.000Z',
  is_unread: false,
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('PersistenceHealthNotifications', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    usePersistenceHealth.setState({ issues: {} });
    useChatStore.setState({
      conversations: [conversation],
      queuedSubmissionRecoveryByConversationId: {},
      retryQueuedSubmissions: async () => undefined,
    });
    notifyActionRequiredMock.mockClear();
    openSettingsMock.mockClear();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    mock.restore();
  });

  it('keeps queued recovery actionable when in-app notifications are disabled', async () => {
    let resolveRetry: (() => void) | undefined;
    const retryQueuedSubmissions = mock(() => new Promise<void>((resolve) => {
      resolveRetry = resolve;
    }));
    useChatStore.setState({
      queuedSubmissionRecoveryByConversationId: {
        [conversation.id]: { count: 2 },
      },
      retryQueuedSubmissions,
    });

    await act(async () => {
      root?.render(<PersistenceHealthNotifications />);
      await flush();
    });

    const panel = container.querySelector<HTMLElement>('[data-persistence-recovery-panel="true"]');
    const button = panel?.querySelector<HTMLButtonElement>('button');
    expect(appState.inAppNotificationsEnabled).toBe(false);
    expect(panel?.getAttribute('aria-label')).toBe('Queued messages need attention');
    expect(panel?.textContent).toContain('Recovery conversation');
    expect(panel?.textContent).toContain('×2');
    expect(button?.getAttribute('aria-label')).toBe('Retry Recovery conversation');
    expect(button).not.toBeNull();

    await act(async () => {
      button?.click();
      button?.click();
      await flush();
    });

    expect(retryQueuedSubmissions).toHaveBeenCalledTimes(1);
    expect(button?.disabled).toBe(true);
    expect(notifyActionRequiredMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveRetry?.();
      useChatStore.setState({ queuedSubmissionRecoveryByConversationId: {} });
      await flush();
    });

    expect(container.querySelector('[data-persistence-recovery-panel="true"]')).toBeNull();
  });

  it('keeps persistence errors visible without a dismiss action', async () => {
    usePersistenceHealth.setState({ issues: { 'chat-queue': 'The queued message could not be saved.' } });

    await act(async () => {
      root?.render(<PersistenceHealthNotifications />);
      await flush();
    });

    const panel = container.querySelector<HTMLElement>('[data-persistence-recovery-panel="true"]');
    expect(panel?.getAttribute('aria-label')).toBe('Recovery required. Original data preserved.');
    expect(panel?.querySelector('[role="alert"]')?.textContent).toContain('The queued message could not be saved.');
    expect(panel?.querySelector('button')).toBeNull();
  });

  it('releases the retry lock without an unhandled rejection when the action rejects', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    const retryQueuedSubmissions = mock(async () => {
      throw new Error('Retry transport failed');
    });
    useChatStore.setState({
      queuedSubmissionRecoveryByConversationId: {
        [conversation.id]: { count: 1, error: 'The provider is unavailable.' },
      },
      retryQueuedSubmissions,
    });
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await act(async () => {
        root?.render(<PersistenceHealthNotifications />);
        await flush();
      });

      const button = container.querySelector<HTMLButtonElement>('button');
      await act(async () => {
        button?.click();
        await flush();
      });

      expect(retryQueuedSubmissions).toHaveBeenCalledTimes(1);
      expect(button?.disabled).toBe(false);
      expect(container.textContent).toContain('The provider is unavailable.');
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
  it('keeps recovery below modal dialogs and restores its action when the dialog closes', async () => {
    const retryAction = mock(async () => undefined);
    useChatStore.setState({ retryQueuedSubmissions: retryAction, queuedSubmissionRecoveryByConversationId: { [conversation.id]: { count: 1 } } });
    const render = (open: boolean) => (
      <>
        <PersistenceHealthNotifications />
        {open && <Dialog title="Synthetic settings" onClose={() => undefined}><button>Settings control</button></Dialog>}
      </>
    );
    await act(async () => { root!.render(render(true)); });
    const panel = container.querySelector('[data-persistence-recovery-panel]')!;
    const dialog = document.querySelector('[role="dialog"]')!;
    // These are the product's Tailwind layers, not a test-only inline style.
    expect(panel.classList.contains('z-40')).toBe(true);
    expect(dialog.closest('.z-50')).not.toBeNull();
    expect(container.hasAttribute('inert')).toBe(true);
    expect(useChatStore.getState().queuedSubmissionRecoveryByConversationId[conversation.id]?.count).toBe(1);
    await act(async () => { root!.render(render(false)); });
    expect(container.hasAttribute('inert')).toBe(false);
    const retry = container.querySelector('button')!;
    await act(async () => { retry.click(); await flush(); });
    expect(retryAction).toHaveBeenCalledWith(conversation.id);
    expect(container.querySelector('[data-persistence-recovery-panel]')).not.toBeNull();
  });

});
