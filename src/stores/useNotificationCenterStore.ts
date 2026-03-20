import { create } from 'zustand';
import { PREF_KEYS, savePreference } from '../services/preferences';

export type NotificationLevel = 'info' | 'warning' | 'error';

export interface NotificationCenterItem {
  id: string;
  level: NotificationLevel;
  title: string;
  description?: string;
  createdAt: string;
  readAt: string | null;
}

interface NotificationCenterStore {
  items: NotificationCenterItem[];
  isCenterOpen: boolean;
  setCenterOpen: (open: boolean) => void;
  addItem: (level: NotificationLevel, title: string, description?: string) => void;
  removeItem: (id: string) => void;
  clearAll: () => void;
  markAllRead: () => void;
}

export const NOTIFICATION_CENTER_MAX_ITEMS = 100;
export const NOTIFICATION_CENTER_STORAGE_KEY = `macro_${PREF_KEYS.NOTIFICATION_CENTER_ITEMS}`;

const isNotificationLevel = (value: unknown): value is NotificationLevel =>
  value === 'info' || value === 'warning' || value === 'error';

const isValidIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim()) return false;
  return Number.isFinite(new Date(value).getTime());
};

const getLocalStorage = (): Storage | null => {
  if (!('localStorage' in globalThis)) {
    return null;
  }

  return globalThis.localStorage ?? null;
};

const createNotificationId = (): string => {
  if ('crypto' in globalThis && typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `notification-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export const sanitizeNotificationCenterItems = (value: unknown): NotificationCenterItem[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((entry): NotificationCenterItem[] => {
      if (!entry || typeof entry !== 'object') {
        return [];
      }

      const item = entry as Partial<NotificationCenterItem>;
      if (
        typeof item.id !== 'string' ||
        !item.id.trim() ||
        !isNotificationLevel(item.level) ||
        typeof item.title !== 'string' ||
        !item.title.trim() ||
        !isValidIsoDate(item.createdAt)
      ) {
        return [];
      }

      const description =
        typeof item.description === 'string' && item.description.trim()
          ? item.description.trim()
          : undefined;
      const readAt = isValidIsoDate(item.readAt) ? item.readAt : null;

      return [
        {
          id: item.id,
          level: item.level,
          title: item.title.trim(),
          description,
          createdAt: item.createdAt,
          readAt,
        },
      ];
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

const persistNotificationCenterItems = (items: NotificationCenterItem[]): void => {
  void savePreference(PREF_KEYS.NOTIFICATION_CENTER_ITEMS, items);
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

  addItem: (level, title, description) => {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      return;
    }

    const createdAt = new Date().toISOString();
    const normalizedDescription =
      typeof description === 'string' && description.trim() ? description.trim() : undefined;
    const readAt = get().isCenterOpen ? createdAt : null;

    const nextItems = [
      {
        id: createNotificationId(),
        level,
        title: normalizedTitle,
        description: normalizedDescription,
        createdAt,
        readAt,
      },
      ...get().items,
    ].slice(0, NOTIFICATION_CENTER_MAX_ITEMS);

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
