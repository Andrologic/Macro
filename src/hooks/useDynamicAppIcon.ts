import { useEffect } from 'react';
import { Image as TauriImage } from '@tauri-apps/api/image';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Theme } from '../types/theme';
import { getDesktopPlatform } from '../utils/desktopPlatform';
import { isTauriEnvironment, windowSetMacosAppIconTheme } from '../services/tauriWindow';
import {
  buildWindowsDynamicAppIconSvg,
  WINDOWS_DYNAMIC_APP_ICON_SIZE,
  buildMacosDynamicAppIconThemeSpec,
  type DynamicAppIconPlatform,
  type MacosDynamicAppIconThemeSpec,
  shouldUseMacosDynamicAppIcon,
} from './dynamicAppIconRenderer';

export interface DynamicAppIconSyncDeps {
  isTauriEnvironment: () => boolean;
  getPlatform: () => DynamicAppIconPlatform;
  renderWindowsAppIconPngBytes: (theme: Theme) => Promise<Uint8Array>;
  buildMacosAppIconThemeSpec: (theme: Theme) => MacosDynamicAppIconThemeSpec;
  setWindowIconFromPng: (pngBytes: Uint8Array) => Promise<void>;
  setMacosAppIconTheme: (spec: MacosDynamicAppIconThemeSpec) => Promise<void>;
}

function createIconCanvas(size: number): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to create app icon canvas context');
  }

  return { canvas, context };
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const pngBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) {
        resolve(result);
        return;
      }

      reject(new Error('Failed to encode app icon PNG'));
    }, 'image/png');
  });

  return new Uint8Array(await pngBlob.arrayBuffer());
}

async function renderSvgToPngBytes(svgString: string, size: number): Promise<Uint8Array> {
  const { canvas, context } = createIconCanvas(size);
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new window.Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error('Failed to load app icon SVG'));
      nextImage.src = objectUrl;
    });

    context.clearRect(0, 0, size, size);
    context.drawImage(image, 0, 0, size, size);
    return canvasToPngBytes(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function renderWindowsAppIconPngBytes(theme: Theme): Promise<Uint8Array> {
  const svgString = buildWindowsDynamicAppIconSvg(theme);
  return renderSvgToPngBytes(svgString, WINDOWS_DYNAMIC_APP_ICON_SIZE);
}

async function setWindowIconFromPng(pngBytes: Uint8Array): Promise<void> {
  const icon = await TauriImage.fromBytes(pngBytes);
  await getCurrentWindow().setIcon(icon);
}

const defaultDynamicAppIconSyncDeps: DynamicAppIconSyncDeps = {
  isTauriEnvironment,
  getPlatform: getDesktopPlatform,
  renderWindowsAppIconPngBytes,
  buildMacosAppIconThemeSpec: buildMacosDynamicAppIconThemeSpec,
  setWindowIconFromPng,
  setMacosAppIconTheme: windowSetMacosAppIconTheme,
};

export async function syncDynamicAppIcon(
  theme: Theme,
  deps: DynamicAppIconSyncDeps = defaultDynamicAppIconSyncDeps
): Promise<void> {
  const tauriAvailable = deps.isTauriEnvironment();
  if (!tauriAvailable) {
    return;
  }

  const platform = deps.getPlatform();
  const useMacosNativeIcon = shouldUseMacosDynamicAppIcon({
    isTauriEnvironment: tauriAvailable,
    platform,
  });

  if (useMacosNativeIcon) {
    await deps.setMacosAppIconTheme(deps.buildMacosAppIconThemeSpec(theme));
    return;
  }

  const pngBytes = await deps.renderWindowsAppIconPngBytes(theme);
  await deps.setWindowIconFromPng(pngBytes);
}

export function useDynamicAppIcon(theme: Theme, enabled = true): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const guardedDeps: DynamicAppIconSyncDeps = {
      ...defaultDynamicAppIconSyncDeps,
      setWindowIconFromPng: async (pngBytes) => {
        if (cancelled) {
          return;
        }

        await defaultDynamicAppIconSyncDeps.setWindowIconFromPng(pngBytes);
      },
      setMacosAppIconTheme: async (spec) => {
        if (cancelled) {
          return;
        }

        await defaultDynamicAppIconSyncDeps.setMacosAppIconTheme(spec);
      },
    };

    void syncDynamicAppIcon(theme, guardedDeps).catch((error) => {
      if (!cancelled) {
        console.error('Error updating app icon:', error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, theme]);
}
