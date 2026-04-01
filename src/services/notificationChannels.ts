export type NotificationCategory =
  | 'task_attention_required'
  | 'task_run_completed'
  | 'task_completed'
  | 'git_sync_completed'
  | 'git_sync_attention_required';

export type NotificationChannelMode = 'off' | 'toast' | 'desktop' | 'both';

export type NotificationChannelModes = Record<NotificationCategory, NotificationChannelMode>;

export interface NotificationCategoryDefinition {
  defaultMode: NotificationChannelMode;
  allowedModes: readonly NotificationChannelMode[];
  titleKey: string;
  descriptionKey: string;
}

const ACTIONABLE_NOTIFICATION_CHANNEL_MODES = ['off', 'toast', 'both'] as const;
const STANDARD_NOTIFICATION_CHANNEL_MODES = ['off', 'toast', 'desktop', 'both'] as const;

export const NOTIFICATION_CATEGORY_DEFINITIONS: Record<
  NotificationCategory,
  NotificationCategoryDefinition
> = {
  task_attention_required: {
    defaultMode: 'both',
    allowedModes: ACTIONABLE_NOTIFICATION_CHANNEL_MODES,
    titleKey: 'settings.notificationCategoryTaskAttention',
    descriptionKey: 'settings.notificationCategoryTaskAttentionDesc',
  },
  task_run_completed: {
    defaultMode: 'desktop',
    allowedModes: STANDARD_NOTIFICATION_CHANNEL_MODES,
    titleKey: 'settings.notificationCategoryTaskRunCompleted',
    descriptionKey: 'settings.notificationCategoryTaskRunCompletedDesc',
  },
  task_completed: {
    defaultMode: 'both',
    allowedModes: STANDARD_NOTIFICATION_CHANNEL_MODES,
    titleKey: 'settings.notificationCategoryTaskCompleted',
    descriptionKey: 'settings.notificationCategoryTaskCompletedDesc',
  },
  git_sync_completed: {
    defaultMode: 'desktop',
    allowedModes: STANDARD_NOTIFICATION_CHANNEL_MODES,
    titleKey: 'settings.notificationCategoryGitSyncCompleted',
    descriptionKey: 'settings.notificationCategoryGitSyncCompletedDesc',
  },
  git_sync_attention_required: {
    defaultMode: 'both',
    allowedModes: STANDARD_NOTIFICATION_CHANNEL_MODES,
    titleKey: 'settings.notificationCategoryGitSyncAttention',
    descriptionKey: 'settings.notificationCategoryGitSyncAttentionDesc',
  },
};

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  'task_attention_required',
  'task_run_completed',
  'task_completed',
  'git_sync_completed',
  'git_sync_attention_required',
];

export const DEFAULT_NOTIFICATION_CHANNEL_MODES: NotificationChannelModes =
  NOTIFICATION_CATEGORIES.reduce<NotificationChannelModes>(
    (result, category) => ({
      ...result,
      [category]: NOTIFICATION_CATEGORY_DEFINITIONS[category].defaultMode,
    }),
    {} as NotificationChannelModes
  );

const isNotificationChannelMode = (value: unknown): value is NotificationChannelMode =>
  value === 'off' || value === 'toast' || value === 'desktop' || value === 'both';

export const sanitizeNotificationChannelMode = (
  category: NotificationCategory,
  value: unknown
): NotificationChannelMode => {
  const definition = NOTIFICATION_CATEGORY_DEFINITIONS[category];
  if (isNotificationChannelMode(value) && definition.allowedModes.includes(value)) {
    return value;
  }

  return definition.defaultMode;
};

export const getAllowedNotificationChannelModes = (
  category: NotificationCategory
): readonly NotificationChannelMode[] =>
  NOTIFICATION_CATEGORY_DEFINITIONS[category].allowedModes;

export const sanitizeNotificationChannelModes = (
  value: unknown
): NotificationChannelModes => {
  const result: NotificationChannelModes = {
    ...DEFAULT_NOTIFICATION_CHANNEL_MODES,
  };

  if (!value || typeof value !== 'object') {
    return result;
  }

  for (const category of NOTIFICATION_CATEGORIES) {
    result[category] = sanitizeNotificationChannelMode(
      category,
      (value as Record<string, unknown>)[category]
    );
  }

  return result;
};

export const isToastChannelMode = (mode: NotificationChannelMode): boolean =>
  mode === 'toast' || mode === 'both';

export const isDesktopChannelMode = (mode: NotificationChannelMode): boolean =>
  mode === 'desktop' || mode === 'both';
