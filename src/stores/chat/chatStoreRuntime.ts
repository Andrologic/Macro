export interface ChatStoreRuntimeAdapters<TState> {
  get: () => TState;
  set: (
    partial:
      | Partial<TState>
      | ((state: TState) => Partial<TState> | TState),
  ) => void;
  appStore: { getState: () => unknown };
  providerStore: { getState: () => unknown };
  taskStore: { getState: () => unknown };
  citationsStore: { getState: () => unknown };
  toolsStore: { getState: () => unknown };
  terminalStore: { getState: () => unknown };
  ipc: unknown;
  logger: {
    info: (message: string, payload?: Record<string, unknown>) => void;
  };
  preferences: {
    load: <T>(key: string) => Promise<T | null>;
    save: <T>(key: string, value: T) => Promise<void>;
  };
}
