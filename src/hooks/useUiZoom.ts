import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { isTauriEnvironment, windowSetZoom } from '../services/tauriWindow';
import { isPageShuttingDown } from '../utils/pageLifecycle';
import { getEffectiveUiZoomScale } from '../utils/uiZoom';

let lastAppliedBrowserZoom: number | null = null;
let lastAppliedTauriZoom: number | null = null;
let inflightTauriZoom:
  | {
      scale: number;
      promise: Promise<void>;
    }
  | null = null;

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

        if (lastAppliedTauriZoom === effectiveScale) {
          return;
        }

        if (inflightTauriZoom?.scale === effectiveScale) {
          await inflightTauriZoom.promise;
          return;
        }

        const zoomPromise = windowSetZoom(effectiveScale)
          .then(() => {
            lastAppliedTauriZoom = effectiveScale;
          })
          .finally(() => {
            if (inflightTauriZoom?.scale === effectiveScale) {
              inflightTauriZoom = null;
            }
          });

        inflightTauriZoom = {
          scale: effectiveScale,
          promise: zoomPromise,
        };

        await zoomPromise;
      } catch (error) {
        if (cancelled || isPageShuttingDown()) {
          return;
        }
        console.error('Failed to apply UI zoom:', error);
        applyBrowserZoom(effectiveScale);
      }
    };

    void setupZoom();

    return () => {
      cancelled = true;
    };
  }, [uiZoomMode, uiZoomLevel]);
}
