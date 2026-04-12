import { beforeEach, describe, expect, it, mock } from 'bun:test';

const notifyMock = {
  success: mock((_message?: unknown, _options?: unknown) => 'success-id'),
  info: mock((_message?: unknown, _options?: unknown) => 'info-id'),
  warning: mock((_message?: unknown, _options?: unknown) => 'warning-id'),
  error: mock((_message?: unknown, _options?: unknown) => 'error-id'),
  actionRequired: mock((_message?: unknown, _options?: unknown) => 'action-id'),
};

const sendDesktopNotificationPreviewMock = mock(async (_input?: unknown) => true);

let importCounter = 0;

const loadBlueprintModule = async () => {
  mock.restore();

  mock.module('../../ui/toastService', () => ({
    notify: notifyMock,
  }));

  mock.module('../../../services/desktopNotifications', () => ({
    sendDesktopNotificationPreview: (input: unknown) =>
      sendDesktopNotificationPreviewMock(input),
    maybeSendDesktopNotification: (input: unknown) =>
      sendDesktopNotificationPreviewMock(input),
    getDesktopNotificationStatus: () => 'granted' as const,
    initializeDesktopNotifications: async () => undefined,
    subscribeDesktopNotificationStatus: () => () => undefined,
  }));
  mock.module('../../../services/desktopNotifications.ts', () => ({
    sendDesktopNotificationPreview: (input: unknown) =>
      sendDesktopNotificationPreviewMock(input),
    maybeSendDesktopNotification: (input: unknown) =>
      sendDesktopNotificationPreviewMock(input),
    getDesktopNotificationStatus: () => 'granted' as const,
    initializeDesktopNotifications: async () => undefined,
    subscribeDesktopNotificationStatus: () => () => undefined,
  }));

  importCounter += 1;
  return import(`./notificationDebugCatalog.ts?test=${importCounter}`);
};

describe('notificationDebugCatalog', () => {
  beforeEach(() => {
    notifyMock.success.mockReset();
    notifyMock.success.mockImplementation((_message?: unknown, _options?: unknown) => 'success-id');
    notifyMock.info.mockReset();
    notifyMock.info.mockImplementation((_message?: unknown, _options?: unknown) => 'info-id');
    notifyMock.warning.mockReset();
    notifyMock.warning.mockImplementation((_message?: unknown, _options?: unknown) => 'warning-id');
    notifyMock.error.mockReset();
    notifyMock.error.mockImplementation((_message?: unknown, _options?: unknown) => 'error-id');
    notifyMock.actionRequired.mockReset();
    notifyMock.actionRequired.mockImplementation((_message?: unknown, _options?: unknown) => 'action-id');
    sendDesktopNotificationPreviewMock.mockReset();
    sendDesktopNotificationPreviewMock.mockImplementation(async (_input?: unknown) => true);
  });

  it('exposes stable default drafts for the two blueprints', async () => {
    const {
      DEFAULT_ACTIONABLE_NOTIFICATION_BLUEPRINT_DRAFT,
      DEFAULT_INFORMATIONAL_NOTIFICATION_BLUEPRINT_DRAFT,
    } = await loadBlueprintModule();

    expect(DEFAULT_INFORMATIONAL_NOTIFICATION_BLUEPRINT_DRAFT).toEqual({
      tone: 'info',
      title: 'Background indexing finished',
      description: 'Everything is up to date.',
    });
    expect(DEFAULT_ACTIONABLE_NOTIFICATION_BLUEPRINT_DRAFT).toEqual({
      tone: 'warning',
      title: 'Base branch missing',
      description: 'Choose what to do next to continue safely.',
      actionCount: 2,
      primaryActionLabel: 'Create',
      secondaryActionLabel: 'Open settings',
    });
  });

  it('maps informational blueprint tones to the matching notify helpers', async () => {
    const { emitInformationalNotificationBlueprint } = await loadBlueprintModule();

    await expect(
      emitInformationalNotificationBlueprint(
        {
          tone: 'success',
          title: 'Theme saved successfully',
          description: 'Preview of a success message.',
        },
        'in_app'
      )
    ).resolves.toEqual({
      inAppSent: true,
      desktopSent: false,
    });

    expect(notifyMock.success).toHaveBeenCalledWith(
      'Theme saved successfully',
      expect.objectContaining({
        description: 'Preview of a success message.',
      })
    );
  });

  it('emits actionable blueprints through notify.actionRequired with the requested number of actions', async () => {
    const {
      emitActionableNotificationBlueprint,
      getActionableNotificationBlueprintPreviewActions,
    } = await loadBlueprintModule();

    const previewActions = getActionableNotificationBlueprintPreviewActions({
      tone: 'warning',
      title: 'Base branch missing',
      description: 'Choose what to do next.',
      actionCount: 1,
      primaryActionLabel: 'Create',
      secondaryActionLabel: 'Ignored',
    });

    expect(previewActions).toEqual([
      {
        label: 'Create',
        variant: 'primary',
      },
    ]);

    await expect(
      emitActionableNotificationBlueprint(
        {
          tone: 'warning',
          title: 'Base branch missing',
          description: 'Choose what to do next.',
          actionCount: 2,
          primaryActionLabel: 'Create',
          secondaryActionLabel: 'Open settings',
        },
        'in_app'
      )
    ).resolves.toEqual({
      inAppSent: true,
      desktopSent: false,
    });

    expect(notifyMock.actionRequired).toHaveBeenCalledWith(
      'Base branch missing',
      expect.objectContaining({
        tone: 'warning',
        actions: [
          expect.objectContaining({ label: 'Create', variant: 'primary' }),
          expect.objectContaining({ label: 'Open settings', variant: 'secondary' }),
        ],
      })
    );
  });

  it('emits desktop previews for both blueprints through the dedicated desktop helper', async () => {
    const {
      emitActionableNotificationBlueprint,
      emitInformationalNotificationBlueprint,
    } = await loadBlueprintModule();

    await expect(
      emitInformationalNotificationBlueprint(
        {
          tone: 'error',
          title: 'Git metadata sync failed',
          description: 'Resolve the conflict before retrying the operation.',
        },
        'desktop'
      )
    ).resolves.toEqual({
      inAppSent: false,
      desktopSent: true,
    });

    await expect(
      emitActionableNotificationBlueprint(
        {
          tone: 'info',
          title: 'Git sync needs one more action',
          description: 'A follow-up action is still required.',
          actionCount: 2,
          primaryActionLabel: 'Save @macro',
          secondaryActionLabel: 'Review status',
        },
        'all'
      )
    ).resolves.toEqual({
      inAppSent: true,
      desktopSent: true,
    });

    expect(sendDesktopNotificationPreviewMock).toHaveBeenNthCalledWith(1, {
      title: 'Git metadata sync failed',
      body: 'Resolve the conflict before retrying the operation.',
      notificationKey: 'debug-blueprint:informational',
    });
    expect(sendDesktopNotificationPreviewMock).toHaveBeenNthCalledWith(2, {
      title: 'Git sync needs one more action',
      body: 'A follow-up action is still required.',
      notificationKey: 'debug-blueprint:actionable',
    });
  });
});
