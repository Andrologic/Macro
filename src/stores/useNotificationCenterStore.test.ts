import { beforeEach, describe, expect, it } from 'bun:test';

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

const {
  NOTIFICATION_CENTER_MAX_ITEMS,
  NOTIFICATION_CENTER_STORAGE_KEY,
  readNotificationCenterItemsFromStorage,
  sanitizeNotificationCenterItems,
  useNotificationCenterStore,
} = await import('./useNotificationCenterStore');

describe('useNotificationCenterStore', () => {
  beforeEach(() => {
    localStorageMock.clear();
    useNotificationCenterStore.setState({
      items: [],
      isCenterOpen: false,
    });
  });

  it('adds info, warning, and error items with newest first', () => {
    const store = useNotificationCenterStore.getState();

    store.addItem('info', 'Info toast', 'Helpful context');
    store.addItem('warning', 'Warning toast');
    store.addItem('error', 'Error toast', 'Action required');

    const items = useNotificationCenterStore.getState().items;
    expect(items).toHaveLength(3);
    expect(items[0].level).toBe('error');
    expect(items[1].level).toBe('warning');
    expect(items[2].level).toBe('info');
    expect(items[2].description).toBe('Helpful context');
  });

  it('trims history to the configured maximum', () => {
    const store = useNotificationCenterStore.getState();

    for (let index = 0; index < NOTIFICATION_CENTER_MAX_ITEMS + 5; index += 1) {
      store.addItem('info', `Notification ${index}`);
    }

    const items = useNotificationCenterStore.getState().items;
    expect(items).toHaveLength(NOTIFICATION_CENTER_MAX_ITEMS);
    expect(items[0].title).toBe(`Notification ${NOTIFICATION_CENTER_MAX_ITEMS + 4}`);
    expect(items.at(-1)?.title).toBe('Notification 5');
  });

  it('marks all items as read when the center opens', () => {
    const store = useNotificationCenterStore.getState();
    store.addItem('info', 'Unread one');
    store.addItem('error', 'Unread two');

    expect(useNotificationCenterStore.getState().items.every((item) => item.readAt === null)).toBe(true);

    store.setCenterOpen(true);

    expect(useNotificationCenterStore.getState().isCenterOpen).toBe(true);
    expect(useNotificationCenterStore.getState().items.every((item) => item.readAt !== null)).toBe(true);
  });

  it('creates new items as read while the center is open', () => {
    const store = useNotificationCenterStore.getState();
    store.setCenterOpen(true);
    store.addItem('warning', 'Already read');

    const item = useNotificationCenterStore.getState().items[0];
    expect(item.readAt).toBe(item.createdAt);
  });

  it('removes a single item and clears the full list', () => {
    const store = useNotificationCenterStore.getState();
    store.addItem('info', 'First');
    store.addItem('error', 'Second');

    const secondId = useNotificationCenterStore.getState().items[0].id;
    store.removeItem(secondId);

    expect(useNotificationCenterStore.getState().items.map((item) => item.title)).toEqual(['First']);

    store.clearAll();
    expect(useNotificationCenterStore.getState().items).toEqual([]);
  });

  it('persists items to the dedicated preference storage key and hydrates them back', () => {
    const store = useNotificationCenterStore.getState();
    store.addItem('info', 'Persisted', 'Saved locally');

    const persistedRaw = localStorageMock.getItem(NOTIFICATION_CENTER_STORAGE_KEY);
    expect(persistedRaw).not.toBeNull();

    const hydrated = readNotificationCenterItemsFromStorage();
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({
      level: 'info',
      title: 'Persisted',
      description: 'Saved locally',
    });
  });

  it('sanitizes invalid stored payloads before hydration', () => {
    localStorageMock.setItem(
      NOTIFICATION_CENTER_STORAGE_KEY,
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

    expect(sanitizeNotificationCenterItems(JSON.parse(localStorageMock.getItem(NOTIFICATION_CENTER_STORAGE_KEY)!))).toEqual([
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
