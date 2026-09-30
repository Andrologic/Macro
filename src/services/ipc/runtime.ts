/** runtime IPC wrappers and frontend adapters. */

import { resolveRemoteConfig } from "../providers/remoteHttp";
import { isBrowserRuntimeBridgeEnabled } from "../tauriRuntimeBridge";

/**
 * Check if we're running in Tauri
 */
export function isTauriAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const tauriWindow = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke?: unknown;
    } | null;
  };

  return (
    typeof tauriWindow.__TAURI_INTERNALS__?.invoke === 'function' ||
    isBrowserRuntimeBridgeEnabled()
  );
}

export function isRemoteBackendAvailable(): boolean {
  return resolveRemoteConfig() !== null;
}

/**
 * Wrapper that falls back gracefully when Tauri is not available
 */
export async function safeInvoke<T>(
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  if (!isTauriAvailable()) {
    console.warn("Tauri not available, using fallback");
    return fallback;
  }

  try {
    return await fn();
  } catch (error) {
    console.error("Tauri invoke error:", error);
    throw error;
  }
}
