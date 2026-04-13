import { create } from 'zustand';
import { PREF_KEYS, savePreference } from '../services/preferences';
import {
  type NotificationActionButtonVariant,
  type NotificationVariant,
  type NotificationTemplateSnapshot,
} from '../components/ui/notifications';
import type { NotificationCategory } from '../services/notificationChannels';

export type NotificationLevel = 'info' | 'warning' | 'error';
export type NotificationCenterToastId = string | number;

export interface NotificationCenterSessionAction {
  label: string;
  variant: NotificationActionButtonVariant;
  dismissOnSuccess: boolean;
  onClick: () => void | Promise<void>;
}

export interface NotificationCenterItemInput extends NotificationTemplateSnapshot {
  id: string;
  level: NotificationLevel;
  createdAt: string;
  readAt?: string | null;
  sessionActions?: NotificationCenterSessionAction[];
  sessionToastId?: NotificationCenterToastId | null;
  pendingActionIndex?: number | null;
}

export interface NotificationCenterItem {
  id: string;
  level: NotificationLevel;
  variant: NotificationVariant;
  category?: NotificationCategory;
  title: string;
  description?: string;
  createdAt: string;
  readAt: string | null;
  sessionActions?: NotificationCenterSessionAction[];
  sessionToastId?: NotificationCenterToastId | null;
  pendingActionIndex?: number | null;
}

interface NotificationCenterStore {
  items: NotificationCenterItem[];
  isCenterOpen: boolean;
  setCenterOpen: (open: boolean) => void;
  upsertItem: (item: NotificationCenterItemInput) => void;
  setItemPendingAction: (id: string, pendingActionIndex: number | null) => void;
  removeItem: (id: string) => void;
  clearAll: () => void;
  markAllRead: () => void;
}

export const NOTIFICATION_CENTER_MAX_ITEMS = 100;
export const NOTIFICATION_CENTER_STORAGE_KEY = `macro_${PREF_KEYS.NOTIFICATION_CENTER_ITEMS}`;

const isNotificationLevel = (value: unknown): value is NotificationLevel =>
  value === 'info' || value === 'warning' || value === 'error';

const isNotificationVariant = (value: unknown): value is NotificationVariant =>
  value === 'informational' || value === 'actionable';

const isNotificationActionButtonVariant = (
  value: unknown
): value is NotificationActionButtonVariant =>
  value === 'primary' || value === 'secondary';

const isNotificationCategory = (value: unknown): value is NotificationCategory =>
  value === 'task_attention_required' ||
  value === 'task_run_completed' ||
  value === 'task_completed' ||
  value === 'git_sync_completed' ||
  value === 'git_sync_attention_required';

const isValidIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim()) return false;
  return Number.isFinite(new Date(value).getTime());
};

const isNotificationCenterToastId = (
  value: unknown
): value is NotificationCenterToastId =>
  typeof value === 'string' || typeof value === 'number';

const toNotificationCenterSessionActions = (
  value: unknown
): NotificationCenterSessionAction[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const actions = value.flatMap((entry): NotificationCenterSessionAction[] => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const action = entry as Partial<NotificationCenterSessionAction>;
    if (
      typeof action.label !== 'string' ||
      !action.label.trim() ||
      !isNotificationActionButtonVariant(action.variant) ||
      typeof action.onClick !== 'function'
    ) {
      return [];
    }

    return [
      {
        label: action.label.trim(),
        variant: action.variant,
        dismissOnSuccess: action.dismissOnSuccess !== false,
        onClick: action.onClick,
      },
    ];
  });

  return actions.length > 0 ? actions : undefined;
};

const getLocalStorage = (): Storage | null => {
  if (!('localStorage' in globalThis)) {
    return null;
  }

  return globalThis.localStorage ?? null;
};

const toNotificationCenterItem = (
  value: unknown
): NotificationCenterItem | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const item = value as Partial<NotificationCenterItem>;
  if (
    typeof item.id !== 'string' ||
    !item.id.trim() ||
    !isNotificationLevel(item.level) ||
    typeof item.title !== 'string' ||
    !item.title.trim() ||
    !isValidIsoDate(item.createdAt)
  ) {
    return null;
  }

  const description =
    typeof item.description === 'string' && item.description.trim()
      ? item.description.trim()
      : undefined;
  const variant = isNotificationVariant(item.variant)
    ? item.variant
    : 'informational';
  const category = isNotificationCategory(item.category)
    ? item.category
    : undefined;
  const readAt = isValidIsoDate(item.readAt) ? item.readAt : null;
  const sessionActions =
    variant === 'actionable'
      ? toNotificationCenterSessionActions(
          (item as Partial<NotificationCenterItemInput>).sessionActions
        )
      : undefined;
  const sessionToastId =
    variant === 'actionable' &&
    isNotificationCenterToastId(
      (item as Partial<NotificationCenterItemInput>).sessionToastId
    )
      ? (item as Partial<NotificationCenterItemInput>).sessionToastId
      : null;
  const pendingActionIndex =
    sessionActions &&
    typeof (item as Partial<NotificationCenterItemInput>).pendingActionIndex === 'number' &&
    Number.isInteger((item as Partial<NotificationCenterItemInput>).pendingActionIndex) &&
    (item as Partial<NotificationCenterItemInput>).pendingActionIndex! >= 0 &&
    (item as Partial<NotificationCenterItemInput>).pendingActionIndex! < sessionActions.length
      ? (item as Partial<NotificationCenterItemInput>).pendingActionIndex
      : null;

  return {
    id: item.id.trim(),
    level: item.level,
    variant,
    category,
    title: item.title.trim(),
    description,
    createdAt: item.createdAt,
    readAt,
    ...(sessionActions ? { sessionActions } : {}),
    ...(sessionToastId !== null ? { sessionToastId } : {}),
    ...(pendingActionIndex !== null ? { pendingActionIndex } : {}),
  };
};

export const sanitizeNotificationCenterItems = (value: unknown): NotificationCenterItem[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((entry): NotificationCenterItem[] => {
      const item = toNotificationCenterItem(entry);
      return item ? [item] : [];
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, NOTIFICATION_CENTER_MAX_ITEMS);
};

export const readNotificationCenterItemsFromStorage = (): NotificationCenterItem[] => {
  const storage = getLocalStorage();
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(NOTIFICATION_CENTER_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    return sanitizeNotificationCenterItems(JSON.parse(raw));
  } catch {
    return [];
  }
};

export const hasUnreadNotifications = (items: NotificationCenterItem[]): boolean =>
  items.some((item) => item.readAt === null);

const toPersistedNotificationCenterItem = ({
  sessionActions: _sessionActions,
  sessionToastId: _sessionToastId,
  pendingActionIndex: _pendingActionIndex,
  ...item
}: NotificationCenterItem): NotificationCenterItemInput => item;

const persistNotificationCenterItems = (items: NotificationCenterItem[]): void => {
  void savePreference(
    PREF_KEYS.NOTIFICATION_CENTER_ITEMS,
    items.map(toPersistedNotificationCenterItem)
  );
};

const markNotificationItemsRead = (
  items: NotificationCenterItem[],
  readAt: string
): NotificationCenterItem[] => {
  let didChange = false;

  const nextItems = items.map((item) => {
    if (item.readAt) {
      return item;
    }

    didChange = true;
    return {
      ...item,
      readAt,
    };
  });

  return didChange ? nextItems : items;
};

const initialItems = readNotificationCenterItemsFromStorage();

export const useNotificationCenterStore = create<NotificationCenterStore>((set, get) => ({
  items: initialItems,
  isCenterOpen: false,

  setCenterOpen: (open) => {
    if (!open) {
      set({ isCenterOpen: false });
      return;
    }

    const currentItems = get().items;
    const nextItems = markNotificationItemsRead(currentItems, new Date().toISOString());

    set({
      isCenterOpen: true,
      items: nextItems,
    });

    if (nextItems !== currentItems) {
      persistNotificationCenterItems(nextItems);
    }
  },

  upsertItem: (item) => {
    const normalizedItem = toNotificationCenterItem(item);
    if (!normalizedItem) {
      return;
    }

    const existingItem = get().items.find((currentItem) => currentItem.id === normalizedItem.id);
    const nextItem: NotificationCenterItem =
      normalizedItem.variant === 'actionable'
        ? {
            ...normalizedItem,
            ...(normalizedItem.sessionActions
              ? { sessionActions: normalizedItem.sessionActions }
              : existingItem?.sessionActions
                ? { sessionActions: existingItem.sessionActions }
                : {}),
            ...(normalizedItem.sessionToastId !== undefined
              ? normalizedItem.sessionToastId !== null
                ? { sessionToastId: normalizedItem.sessionToastId }
                : {}
              : existingItem?.sessionToastId !== undefined &&
                  existingItem.sessionToastId !== null
                ? { sessionToastId: existingItem.sessionToastId }
                : {}),
            ...((normalizedItem.pendingActionIndex ?? null) !== null
              ? { pendingActionIndex: normalizedItem.pendingActionIndex }
              : existingItem?.pendingActionIndex !== undefined &&
                  existingItem.pendingActionIndex !== null
                ? { pendingActionIndex: existingItem.pendingActionIndex }
                : {}),
          }
        : normalizedItem;

    const nextItems = [
      nextItem,
      ...get().items.filter((existingItem) => existingItem.id !== normalizedItem.id),
    ]
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .slice(0, NOTIFICATION_CENTER_MAX_ITEMS);

    set({ items: nextItems });
    persistNotificationCenterItems(nextItems);
  },

  setItemPendingAction: (id, pendingActionIndex) => {
    const currentItems = get().items;
    let didChange = false;

    const nextItems = currentItems.map((item) => {
      if (item.id !== id) {
        return item;
      }

      if (!item.sessionActions || item.sessionActions.length === 0) {
        return item;
      }

      const nextPendingActionIndex =
        typeof pendingActionIndex === 'number' &&
        pendingActionIndex >= 0 &&
        pendingActionIndex < item.sessionActions.length
          ? pendingActionIndex
          : null;

      if ((item.pendingActionIndex ?? null) === nextPendingActionIndex) {
        return item;
      }

      didChange = true;

      if (nextPendingActionIndex === null) {
        const { pendingActionIndex: _pendingActionIndex, ...rest } = item;
        return rest;
      }

      return {
        ...item,
        pendingActionIndex: nextPendingActionIndex,
      };
    });

    if (!didChange) {
      return;
    }

    set({ items: nextItems });
    persistNotificationCenterItems(nextItems);
  },

  removeItem: (id) => {
    const currentItems = get().items;
    const nextItems = currentItems.filter((item) => item.id !== id);

    if (nextItems.length === currentItems.length) {
      return;
    }

    set({ items: nextItems });
    persistNotificationCenterItems(nextItems);
  },

  clearAll: () => {
    if (get().items.length === 0) {
      return;
    }

    set({ items: [] });
    persistNotificationCenterItems([]);
  },

  markAllRead: () => {
    const currentItems = get().items;
    const nextItems = markNotificationItemsRead(currentItems, new Date().toISOString());

    if (nextItems === currentItems) {
      return;
    }

    set({ items: nextItems });
    persistNotificationCenterItems(nextItems);
  },
}));
