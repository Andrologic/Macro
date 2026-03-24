import { beforeEach, describe, expect, it, mock } from 'bun:test';

interface LocalStorageMock {
  clear: () => void;
  getItem: (key: string) => string | null;
  key: (index: number) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
  readonly length: number;
}

const createLocalStorageMock = (): LocalStorageMock => {
  const store = new Map<string, string>();

  return {
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    get length() {
      return store.size;
    },
  };
};

const localStorageMock = createLocalStorageMock();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
  writable: true,
});

let importCounter = 0;

const createNotificationItem = (
  index: number,
  overrides: Record<string, unknown> = {}
) => ({
  id: `notification-${index}`,
  level: 'info' as const,
  title: `Notification ${index}`,
  createdAt: new Date(Date.UTC(2026, 2, 20, 12, 0, index)).toISOString(),
  readAt: null,
  ...overrides,
});

const loadNotificationCenterStore = async () => {
  mock.module('../services/preferences', () => ({
    PREF_KEYS: {
      NOTIFICATION_CENTER_ITEMS: 'notificationCenterItems',
    },
    savePreference: async (key: string, value: unknown) => {
      localStorageMock.setItem(`macro_${key}`, JSON.stringify(value));
    },
  }));
  importCounter += 1;
  return import(`./useNotificationCenterStore.ts?notification-test=${importCounter}`);
};

describe('useNotificationCenterStore', () => {
  let notificationStore: Awaited<ReturnType<typeof loadNotificationCenterStore>>;

  beforeEach(() => {
    mock.restore();
    localStorageMock.clear();
  });

  beforeEach(async () => {
    notificationStore = await loadNotificationCenterStore();
    notificationStore.useNotificationCenterStore.setState({
      items: [],
      isCenterOpen: false,
    });
  });

  it('upserts info, warning, and error items with newest first', () => {
    const store = notificationStore.useNotificationCenterStore.getState();

    store.upsertItem(
      createNotificationItem(1, {
        title: 'Info toast',
        description: 'Helpful context',
      })
    );
    store.upsertItem(
      createNotificationItem(2, {
        id: 'warning-toast',
        level: 'warning',
        title: 'Warning toast',
      })
    );
    store.upsertItem(
      createNotificationItem(3, {
        id: 'error-toast',
        level: 'error',
        title: 'Error toast',
        description: 'Action required',
      })
    );

    const items = notificationStore.useNotificationCenterStore.getState().items;
    expect(items).toHaveLength(3);
    expect(items[0].level).toBe('error');
    expect(items[1].level).toBe('warning');
    expect(items[2].level).toBe('info');
    expect(items[2].description).toBe('Helpful context');
  });

  it('trims history to the configured maximum', () => {
    const store = notificationStore.useNotificationCenterStore.getState();

    for (let index = 0; index < notificationStore.NOTIFICATION_CENTER_MAX_ITEMS + 5; index += 1) {
      store.upsertItem(createNotificationItem(index));
    }

    const items = notificationStore.useNotificationCenterStore.getState().items;
    expect(items).toHaveLength(notificationStore.NOTIFICATION_CENTER_MAX_ITEMS);
    expect(items[0].title).toBe(`Notification ${notificationStore.NOTIFICATION_CENTER_MAX_ITEMS + 4}`);
    expect(items.at(-1)?.title).toBe('Notification 5');
  });

  it('marks all items as read when the center opens', () => {
    const store = notificationStore.useNotificationCenterStore.getState();
    store.upsertItem(createNotificationItem(1, { title: 'Unread one' }));
    store.upsertItem(createNotificationItem(2, { level: 'error', title: 'Unread two' }));

    expect(
      notificationStore.useNotificationCenterStore.getState().items.every(
        (item: { readAt: string | null }) => item.readAt === null
      )
    ).toBe(true);

    store.setCenterOpen(true);

    expect(notificationStore.useNotificationCenterStore.getState().isCenterOpen).toBe(true);
    expect(
      notificationStore.useNotificationCenterStore.getState().items.every(
        (item: { readAt: string | null }) => item.readAt !== null
      )
    ).toBe(true);
  });

  it('preserves provided read state when items are upserted', () => {
    const store = notificationStore.useNotificationCenterStore.getState();
    store.setCenterOpen(true);
    const createdAt = '2026-03-20T12:00:42.000Z';
    store.upsertItem(
      createNotificationItem(42, {
        level: 'warning',
        title: 'Already read',
        createdAt,
        readAt: createdAt,
      })
    );

    const item = notificationStore.useNotificationCenterStore.getState().items[0];
    expect(item.readAt).toBe(item.createdAt);
  });

  it('removes a single item and clears the full list', () => {
    const store = notificationStore.useNotificationCenterStore.getState();
    store.upsertItem(createNotificationItem(1, { title: 'First' }));
    store.upsertItem(createNotificationItem(2, { level: 'error', title: 'Second' }));

    const secondId = notificationStore.useNotificationCenterStore.getState().items[0].id;
    store.removeItem(secondId);

    expect(
      notificationStore.useNotificationCenterStore.getState().items.map(
        (item: { title: string }) => item.title
      )
    ).toEqual(['First']);

    store.clearAll();
    expect(notificationStore.useNotificationCenterStore.getState().items).toEqual([]);
  });

  it('persists items to the dedicated preference storage key and hydrates them back', () => {
    const store = notificationStore.useNotificationCenterStore.getState();
    store.upsertItem(
      createNotificationItem(1, {
        title: 'Persisted',
        description: 'Saved locally',
      })
    );

    const persistedRaw = localStorageMock.getItem(notificationStore.NOTIFICATION_CENTER_STORAGE_KEY);
    expect(persistedRaw).not.toBeNull();

    const hydrated = notificationStore.readNotificationCenterItemsFromStorage();
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({
      level: 'info',
      title: 'Persisted',
      description: 'Saved locally',
    });
  });

  it('replaces an existing item when the same id is upserted again', () => {
    const store = notificationStore.useNotificationCenterStore.getState();

    store.upsertItem(createNotificationItem(1, { title: 'Initial title' }));
    store.upsertItem(
      createNotificationItem(5, {
        id: 'notification-1',
        level: 'error',
        title: 'Updated title',
        description: 'Updated description',
      })
    );

    expect(notificationStore.useNotificationCenterStore.getState().items).toEqual([
      {
        id: 'notification-1',
        level: 'error',
        title: 'Updated title',
        description: 'Updated description',
        createdAt: '2026-03-20T12:00:05.000Z',
        readAt: null,
      },
    ]);
  });

  it('sanitizes invalid stored payloads before hydration', () => {
    localStorageMock.setItem(
      notificationStore.NOTIFICATION_CENTER_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'valid-1',
          level: 'warning',
          title: 'Keep me',
          createdAt: '2026-03-20T12:00:00.000Z',
          readAt: null,
        },
        {
          id: 'invalid-level',
          level: 'success',
          title: 'Drop me',
          createdAt: '2026-03-20T12:01:00.000Z',
          readAt: null,
        },
      ])
    );

    expect(
      notificationStore.sanitizeNotificationCenterItems(
        JSON.parse(localStorageMock.getItem(notificationStore.NOTIFICATION_CENTER_STORAGE_KEY)!)
      )
    ).toEqual([
      {
        id: 'valid-1',
        level: 'warning',
        title: 'Keep me',
        createdAt: '2026-03-20T12:00:00.000Z',
        readAt: null,
      },
    ]);
  });
});
