import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function applyBrowserZoom(scale: number): void {
  document.documentElement.style.fontSize = `${16 * scale}px`;
}

export function useUiZoom() {
  const uiZoomMode = useAppStore((state) => state.uiZoomMode);
  const uiZoomLevel = useAppStore((state) => state.uiZoomLevel);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupZoom = async () => {
      if (!isTauri()) {
        applyBrowserZoom(uiZoomMode === 'override' ? uiZoomLevel : 1);
        return;
      }

      try {
        const [{ getCurrentWindow }, { getCurrentWebview }] = await Promise.all([
          import('@tauri-apps/api/window'),
          import('@tauri-apps/api/webview'),
        ]);

        const win = getCurrentWindow();
        const webview = getCurrentWebview();
        const systemScale = await win.scaleFactor();
        const effectiveScale = uiZoomMode === 'auto' ? systemScale : uiZoomLevel;

        await webview.setZoom(effectiveScale);

        if (uiZoomMode === 'auto') {
          unlisten = await win.onScaleChanged(({ payload }) => {
            void webview.setZoom(payload.scaleFactor);
          });
        }
      } catch (error) {
        console.error('Failed to apply UI zoom:', error);
        applyBrowserZoom(uiZoomMode === 'override' ? uiZoomLevel : 1);
      }
    };

    void setupZoom();

    return () => {
      unlisten?.();
    };
  }, [uiZoomMode, uiZoomLevel]);
}
