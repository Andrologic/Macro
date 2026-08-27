import {
  invoke as invokeTauri,
  type InvokeArgs,
  type InvokeOptions,
} from '@tauri-apps/api/core';
import {
  listen as listenTauri,
  type EventCallback,
  type EventName,
  type Options,
  type UnlistenFn,
} from '@tauri-apps/api/event';

const readBridgeFlag = (): string | undefined => {
  const env = (import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  }).env;
  return env?.VITE_TAURI_BROWSER_BRIDGE;
};

const hasNativeTauriRuntime = (): boolean => {
  if (typeof window === 'undefined') return false;
  const runtimeWindow = window as Window & {
    __TAURI_INTERNALS__?: { invoke?: unknown };
  };
  return typeof runtimeWindow.__TAURI_INTERNALS__?.invoke === 'function';
};

export const isBrowserRuntimeBridgeEnabled = (): boolean =>
  Boolean(
    import.meta.env.DEV &&
    readBridgeFlag() === '1' &&
    !hasNativeTauriRuntime()
  );

export async function invoke<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  if (import.meta.env.DEV && isBrowserRuntimeBridgeEnabled()) {
    const bridge = await import('./browserRuntimeTransport');
    return bridge.invokeBrowserRuntime<T>(command, args, options);
  }

  return invokeTauri<T>(command, args, options);
}

export async function listen<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  if (import.meta.env.DEV && isBrowserRuntimeBridgeEnabled()) {
    const bridge = await import('./browserRuntimeTransport');
    return bridge.listenBrowserRuntime<T>(event, handler, options);
  }

  return listenTauri<T>(event, handler, options);
}

export type { UnlistenFn };
