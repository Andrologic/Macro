import { mock } from 'bun:test';

type TauriInvoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;

export const installTauriRuntimeMock = (
  invoke: TauriInvoke = mock(async () => undefined)
): TauriInvoke => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke },
  });

  return invoke;
};

export const removeTauriRuntimeMock = (): void => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
};
