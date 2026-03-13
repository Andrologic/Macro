import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { isTauriEnvironment, windowSetZoom } from '../services/tauriWindow';

function isTauri(): boolean {
  return isTauriEnvironment();
}

function applyBrowserZoom(scale: number): void {
  document.documentElement.style.fontSize = `${16 * scale}px`;
}

export function useUiZoom() {
  const uiZoomMode = useAppStore((state) => state.uiZoomMode);
  const uiZoomLevel = useAppStore((state) => state.uiZoomLevel);

  useEffect(() => {
    const setupZoom = async () => {
      if (!isTauri()) {
        applyBrowserZoom(uiZoomMode === 'override' ? uiZoomLevel : 1);
        return;
      }

      try {
        const effectiveScale = uiZoomMode === 'auto' ? 1 : uiZoomLevel;

        await windowSetZoom(effectiveScale);
      } catch (error) {
        console.error('Failed to apply UI zoom:', error);
        applyBrowserZoom(uiZoomMode === 'override' ? uiZoomLevel : 1);
      }
    };

    void setupZoom();
  }, [uiZoomMode, uiZoomLevel]);
}
