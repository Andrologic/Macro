import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { DebugNotificationPreview } from './notificationDebugCatalog';

const toastMock = {
  success: mock((_message?: unknown, _options?: unknown) => 'success-id'),
  info: mock((_message?: unknown, _options?: unknown) => 'info-id'),
  warning: mock((_message?: unknown, _options?: unknown) => 'warning-id'),
  error: mock((_message?: unknown, _options?: unknown) => 'error-id'),
};

const sendDesktopNotificationPreviewMock = mock(async (_input?: unknown) => true);

let importCounter = 0;

const loadCatalogModule = async () => {
  mock.restore();

  mock.module('../../ui/toastService', () => ({
    toast: toastMock,
  }));

  mock.module('../../../services/desktopNotifications', () => ({
    sendDesktopNotificationPreview: (input: unknown) =>
      sendDesktopNotificationPreviewMock(input),
  }));

  importCounter += 1;
  return import(`./notificationDebugCatalog.ts?test=${importCounter}`);
};

describe('notificationDebugCatalog', () => {
  beforeEach(() => {
    toastMock.success.mockReset();
    toastMock.success.mockImplementation((_message?: unknown, _options?: unknown) => 'success-id');
    toastMock.info.mockReset();
    toastMock.info.mockImplementation((_message?: unknown, _options?: unknown) => 'info-id');
    toastMock.warning.mockReset();
    toastMock.warning.mockImplementation((_message?: unknown, _options?: unknown) => 'warning-id');
    toastMock.error.mockReset();
    toastMock.error.mockImplementation((_message?: unknown, _options?: unknown) => 'error-id');
    sendDesktopNotificationPreviewMock.mockReset();
    sendDesktopNotificationPreviewMock.mockImplementation(async (_input?: unknown) => true);
  });

  it('defines the canonical preview catalogue in a stable order', async () => {
    const { DEBUG_NOTIFICATION_PREVIEWS } = await loadCatalogModule();

    expect(
      DEBUG_NOTIFICATION_PREVIEWS.map(
        (preview: DebugNotificationPreview) => preview.id
      )
    ).toEqual([
      'uncategorized-info',
      'uncategorized-warning',
      'uncategorized-error',
      'uncategorized-success',
      'uncategorized-actionable',
      'task-attention-required',
      'task-run-completed',
      'task-completed',
      'git-sync-completed',
      'git-sync-pending',
    ]);
  });

  it('emits categorized in-app previews through the toast wrapper without forcing category routing', async () => {
    const { DEBUG_NOTIFICATION_PREVIEWS, emitDebugNotificationPreview } = await loadCatalogModule();
    const preview = DEBUG_NOTIFICATION_PREVIEWS.find(
      (item: DebugNotificationPreview) => item.id === 'task-run-completed'
    );

    expect(preview).toBeDefined();

    await expect(
      emitDebugNotificationPreview(preview!, 'in_app')
    ).resolves.toEqual({
      inAppSent: true,
      desktopSent: false,
    });

    expect(toastMock.success).toHaveBeenCalledWith(
      'Task commands completed',
      expect.any(Object)
    );
    const options = toastMock.success.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty('notification');
    expect(sendDesktopNotificationPreviewMock).not.toHaveBeenCalled();
  });

  it('emits desktop previews through the dedicated desktop helper', async () => {
    const { DEBUG_NOTIFICATION_PREVIEWS, emitDebugNotificationPreview } = await loadCatalogModule();
    const preview = DEBUG_NOTIFICATION_PREVIEWS.find(
      (item: DebugNotificationPreview) => item.id === 'uncategorized-error'
    );

    expect(preview).toBeDefined();

    await expect(
      emitDebugNotificationPreview(preview!, 'desktop')
    ).resolves.toEqual({
      inAppSent: false,
      desktopSent: true,
    });

    expect(sendDesktopNotificationPreviewMock).toHaveBeenCalledWith({
      title: 'Git metadata sync failed',
      body: 'Resolve the conflict before retrying the operation.',
      notificationKey: 'debug-preview:uncategorized-error',
    });
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('replays preview batches in a stable order across all channels', async () => {
    const {
      DEBUG_NOTIFICATION_PREVIEWS,
      emitAllDebugNotificationPreviews,
    } = await loadCatalogModule();
    const order: string[] = [];

    toastMock.info.mockImplementation((message?: unknown) => {
      order.push(`toast:${String(message)}`);
      return 'info-id';
    });
    toastMock.error.mockImplementation((message?: unknown) => {
      order.push(`toast:${String(message)}`);
      return 'error-id';
    });
    sendDesktopNotificationPreviewMock.mockImplementation(async (input?: unknown) => {
      order.push(`desktop:${String((input as { title?: string } | undefined)?.title)}`);
      return true;
    });

    const subset = [
      DEBUG_NOTIFICATION_PREVIEWS[0],
      DEBUG_NOTIFICATION_PREVIEWS[2],
    ];

    await expect(
      emitAllDebugNotificationPreviews('all', subset, 0)
    ).resolves.toEqual({
      total: 2,
      inAppSent: 2,
      desktopSent: 2,
    });

    expect(order).toEqual([
      'toast:Background indexing finished',
      'desktop:Background indexing finished',
      'toast:Git metadata sync failed',
      'desktop:Git metadata sync failed',
    ]);
  });
});
