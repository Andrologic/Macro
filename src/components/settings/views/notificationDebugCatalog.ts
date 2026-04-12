import {
  sendDesktopNotificationPreview,
  type DesktopNotificationInput,
} from '../../../services/desktopNotifications';
import type { NotificationCategory } from '../../../services/notificationChannels';
import {
  toast,
  type NotificationActionSpec,
  type NotificationOptions,
} from '../../ui/toastService';

export type DebugNotificationPreviewLevel = 'info' | 'warning' | 'error' | 'success';
export type DebugNotificationPreviewVariant =
  | 'standard'
  | 'actionable'
  | 'category'
  | 'pending';
export type DebugNotificationPreviewChannel = 'in_app' | 'desktop' | 'all';

export interface DebugNotificationPreview {
  id: string;
  label: string;
  description: string;
  level: DebugNotificationPreviewLevel;
  message: string;
  toastOptions: NotificationOptions;
  notificationCategory?: NotificationCategory;
  supportsDesktop: boolean;
  variant: DebugNotificationPreviewVariant;
}

export interface DebugNotificationEmitResult {
  inAppSent: boolean;
  desktopSent: boolean;
}

export interface DebugNotificationBatchResult {
  total: number;
  inAppSent: number;
  desktopSent: number;
}

export const DEBUG_NOTIFICATION_PREVIEW_DELAY_MS = 160;

const wait = async (durationMs: number): Promise<void> => {
  if (durationMs <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, durationMs);
  });
};

const createPreviewAction = (
  label: string,
  variant: NotificationActionSpec['variant'] = 'primary'
): NotificationActionSpec => ({
  label,
  variant,
  onClick: async () => {
    await wait(320);
  },
});

const getPreviewDescription = (options: NotificationOptions): string | undefined => {
  return typeof options.description === 'string' && options.description.trim()
    ? options.description.trim()
    : undefined;
};

const toDesktopPreviewInput = (
  preview: DebugNotificationPreview
): DesktopNotificationInput => {
  const configuredTitle = preview.toastOptions.notification?.title?.trim();
  const configuredBody = preview.toastOptions.notification?.body?.trim();
  const description = getPreviewDescription(preview.toastOptions);

  return {
    title: configuredTitle || preview.message,
    body: configuredBody || description,
    notificationKey: `debug-preview:${preview.id}`,
  };
};

const toInAppToastOptions = (
  preview: DebugNotificationPreview
): NotificationOptions => {
  const { notification: _notification, ...options } = preview.toastOptions;
  return {
    ...options,
  };
};

const emitInAppPreview = (preview: DebugNotificationPreview): boolean => {
  const options = toInAppToastOptions(preview);

  const result =
    preview.level === 'success'
      ? toast.success(preview.message, options)
      : preview.level === 'info'
        ? toast.info(preview.message, options)
        : preview.level === 'warning'
          ? toast.warning(preview.message, options)
          : toast.error(preview.message, options);

  return result !== 'notifications-disabled';
};

export const DEBUG_NOTIFICATION_PREVIEWS: DebugNotificationPreview[] = [
  {
    id: 'uncategorized-info',
    label: 'Informational toast',
    description:
      'Standard informational styling. In-app previews should also create a tracked entry in the notification center.',
    level: 'info',
    message: 'Background indexing finished',
    toastOptions: {
      description: 'Preview of the default informational notification design.',
      duration: 5000,
      closeButton: true,
    },
    supportsDesktop: true,
    variant: 'standard',
  },
  {
    id: 'uncategorized-warning',
    label: 'Warning toast',
    description:
      'Warning styling for non-blocking issues that still need a closer look.',
    level: 'warning',
    message: 'Workspace scan found partial results',
    toastOptions: {
      description: 'Preview of the warning tone used for attention-grabbing alerts.',
      duration: 7000,
      closeButton: true,
    },
    supportsDesktop: true,
    variant: 'standard',
  },
  {
    id: 'uncategorized-error',
    label: 'Error toast',
    description:
      'High-priority failure styling. In-app previews should create an error entry in the notification center.',
    level: 'error',
    message: 'Git metadata sync failed',
    toastOptions: {
      description: 'Resolve the conflict before retrying the operation.',
      duration: 9000,
      closeButton: true,
    },
    supportsDesktop: true,
    variant: 'standard',
  },
  {
    id: 'uncategorized-success',
    label: 'Success toast',
    description:
      'Success styling for positive confirmations. This preview should stay out of the notification center.',
    level: 'success',
    message: 'Theme saved successfully',
    toastOptions: {
      description: 'Preview of a positive confirmation toast.',
      duration: 4500,
      closeButton: true,
    },
    supportsDesktop: true,
    variant: 'standard',
  },
  {
    id: 'uncategorized-actionable',
    label: 'Actionable toast',
    description:
      'Shared actionable card with two buttons, loading states, and dismiss-on-success behavior.',
    level: 'warning',
    message: 'Base branch missing',
    toastOptions: {
      description: 'Choose what to do next to continue safely.',
      actions: [
        createPreviewAction('Create', 'primary'),
        createPreviewAction('Open settings', 'secondary'),
      ],
      duration: 12000,
      closeButton: true,
    },
    supportsDesktop: true,
    variant: 'actionable',
  },
  {
    id: 'task-attention-required',
    label: 'Task attention required',
    description:
      'Categorized preview for actionable task issues that require an explicit user decision.',
    level: 'warning',
    message: 'Task needs attention before continuing',
    toastOptions: {
      description: 'This category is used for missing branches or blocking task setup issues.',
      actions: [
        createPreviewAction('Fix issue', 'primary'),
        createPreviewAction('Review task', 'secondary'),
      ],
      duration: 12000,
      closeButton: true,
      notification: {
        category: 'task_attention_required',
      },
    },
    notificationCategory: 'task_attention_required',
    supportsDesktop: true,
    variant: 'category',
  },
  {
    id: 'task-run-completed',
    label: 'Task run completed',
    description:
      'Categorized completion preview for long-running task commands that finish successfully.',
    level: 'success',
    message: 'Task commands completed',
    toastOptions: {
      description: '3 repositories finished their task commands successfully.',
      duration: 7000,
      closeButton: true,
      notification: {
        category: 'task_run_completed',
      },
    },
    notificationCategory: 'task_run_completed',
    supportsDesktop: true,
    variant: 'category',
  },
  {
    id: 'task-completed',
    label: 'Task completed',
    description:
      'Categorized success preview for a task moving to its finished state.',
    level: 'success',
    message: 'Task finished',
    toastOptions: {
      description: 'The implementation moved to a completed state.',
      duration: 7000,
      closeButton: true,
      notification: {
        category: 'task_completed',
      },
    },
    notificationCategory: 'task_completed',
    supportsDesktop: true,
    variant: 'category',
  },
  {
    id: 'git-sync-completed',
    label: 'Git sync completed',
    description:
      'Categorized success preview for fetch, pull, push, or metadata sync finishing cleanly.',
    level: 'success',
    message: 'Git sync complete',
    toastOptions: {
      description: 'All repositories and @macro metadata are up to date.',
      duration: 7000,
      closeButton: true,
      notification: {
        category: 'git_sync_completed',
      },
    },
    notificationCategory: 'git_sync_completed',
    supportsDesktop: true,
    variant: 'category',
  },
  {
    id: 'git-sync-pending',
    label: 'Git sync pending action',
    description:
      'Categorized pending preview with follow-up actions for metadata sync steps that still need confirmation.',
    level: 'info',
    message: 'Git sync needs one more action',
    toastOptions: {
      description: 'The sync finished, but @macro still needs a follow-up action before the flow is complete.',
      actions: [
        createPreviewAction('Save @macro', 'primary'),
        createPreviewAction('Review status', 'secondary'),
      ],
      duration: 12000,
      closeButton: true,
      notification: {
        category: 'git_sync_attention_required',
      },
    },
    notificationCategory: 'git_sync_attention_required',
    supportsDesktop: true,
    variant: 'pending',
  },
];

export const emitDebugNotificationPreview = async (
  preview: DebugNotificationPreview,
  channel: DebugNotificationPreviewChannel
): Promise<DebugNotificationEmitResult> => {
  let inAppSent = false;
  let desktopSent = false;

  if (channel !== 'desktop') {
    inAppSent = emitInAppPreview(preview);
  }

  if (channel !== 'in_app' && preview.supportsDesktop) {
    desktopSent = await sendDesktopNotificationPreview(toDesktopPreviewInput(preview));
  }

  return {
    inAppSent,
    desktopSent,
  };
};

export const emitAllDebugNotificationPreviews = async (
  channel: DebugNotificationPreviewChannel,
  previews: DebugNotificationPreview[] = DEBUG_NOTIFICATION_PREVIEWS,
  delayMs: number = DEBUG_NOTIFICATION_PREVIEW_DELAY_MS
): Promise<DebugNotificationBatchResult> => {
  const result: DebugNotificationBatchResult = {
    total: previews.length,
    inAppSent: 0,
    desktopSent: 0,
  };

  for (const [index, preview] of previews.entries()) {
    const emitted = await emitDebugNotificationPreview(preview, channel);
    if (emitted.inAppSent) {
      result.inAppSent += 1;
    }
    if (emitted.desktopSent) {
      result.desktopSent += 1;
    }

    if (index < previews.length - 1) {
      await wait(delayMs);
    }
  }

  return result;
};
