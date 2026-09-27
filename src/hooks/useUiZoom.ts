import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { isTauriEnvironment, windowSetZoom } from '../services/tauriWindow';
import { isPageShuttingDown } from '../utils/pageLifecycle';
import { getEffectiveUiZoomScale } from '../utils/uiZoom';

let originalFontSize: string | null = null;
let lastAppliedBrowserZoom: number | null = null;
let lastAppliedTauriZoom: number | null = null;
let requestedTauriZoom: number | null = null;
let tauriZoomDrain: Promise<void> | null = null;

function isTauri(): boolean {
  return isTauriEnvironment();
}

function applyBrowserZoom(scale: number): void {
  originalFontSize ??= document.documentElement.style.fontSize;
  document.documentElement.style.fontSize = `${16 * scale}px`;
}

function clearBrowserZoom(): void {
  if (originalFontSize === null) return;
  document.documentElement.style.fontSize = originalFontSize;
  originalFontSize = null;
  lastAppliedBrowserZoom = null;
}

async function applyLatestTauriZoom(scale: number): Promise<void> {
  requestedTauriZoom = scale;
  if (tauriZoomDrain) return tauriZoomDrain;

  tauriZoomDrain = (async () => {
    while (requestedTauriZoom !== null) {
      const nextScale = requestedTauriZoom;
      requestedTauriZoom = null;
      if (lastAppliedTauriZoom === nextScale) {
        clearBrowserZoom();
        continue;
      }
      try {
        await windowSetZoom(nextScale);
        clearBrowserZoom();
      } catch (error) {
        if (requestedTauriZoom !== null) {
          continue;
        }
        throw error;
      }
      lastAppliedTauriZoom = nextScale;
    }
  })().finally(() => {
    tauriZoomDrain = null;
  });
  return tauriZoomDrain;
}

export function useUiZoom() {
  const uiZoomMode = useAppStore((state) => state.uiZoomMode);
  const uiZoomLevel = useAppStore((state) => state.uiZoomLevel);

  useEffect(() => {
    let cancelled = false;

    const setupZoom = async () => {
      if (cancelled || isPageShuttingDown()) {
        return;
      }

      const effectiveScale = getEffectiveUiZoomScale(uiZoomMode, uiZoomLevel);

      if (!isTauri()) {
        if (lastAppliedBrowserZoom !== effectiveScale) {
          applyBrowserZoom(effectiveScale);
          lastAppliedBrowserZoom = effectiveScale;
        }
        return;
      }

      try {
        if (cancelled || isPageShuttingDown()) {
          return;
        }

        await applyLatestTauriZoom(effectiveScale);
      } catch (error) {
        if (cancelled || isPageShuttingDown()) {
          return;
        }
        console.error('Failed to apply UI zoom:', error);
        applyBrowserZoom(effectiveScale / (lastAppliedTauriZoom ?? 1));
      }
    };

    void setupZoom();

    return () => {
      cancelled = true;
    };
  }, [uiZoomMode, uiZoomLevel]);
}
