type TauriWindow = Window & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const tauriWindow = window as TauriWindow;

  return (
    tauriWindow.__TAURI__ !== undefined ||
    tauriWindow.__TAURI_INTERNALS__ !== undefined ||
    window.location.protocol === 'tauri:'
  );
}
