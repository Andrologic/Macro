import { RuntimeCommandError } from './runtimeCommandError';
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
  return import.meta.env.VITE_TAURI_BROWSER_BRIDGE;
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

/** HTTP opts into response provenance; ordinary invoke consumers are unchanged. */
export async function invokeWithReceipt<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  if (import.meta.env.DEV && isBrowserRuntimeBridgeEnabled()) {
    const bridge = await import('./browserRuntimeTransport');
    return bridge.invokeBrowserRuntimeWithReceipt<T>(command, args, options);
  }
  const internals = typeof window === 'undefined' ? undefined : (window as Window & {
    __TAURI_INTERNALS__?: {
      transformCallback: (callback: (payload: unknown) => void, once: boolean) => number;
      unregisterCallback: (id: number) => void;
      ipc?: (message: { cmd: string; payload: InvokeArgs; options?: InvokeOptions; callback: number; error: number }) => void;
    };
  }).__TAURI_INTERNALS__;
  // Without the callback port, a rejection has no reliable reply provenance.
  if (!internals?.ipc) return invokeTauri<T>(command, args, options);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      internals.unregisterCallback(callback);
      internals.unregisterCallback(error);
    };
    const callback = internals.transformCallback(payload => { cleanup(); resolve(payload as T); }, true);
    const error = internals.transformCallback(payload => { cleanup(); reject(new RuntimeCommandError(payload)); }, true);
    try { internals.ipc!({ cmd: command, payload: args ?? {}, options, callback, error }); }
    catch (failure) { cleanup(); reject(failure); }
  });
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
