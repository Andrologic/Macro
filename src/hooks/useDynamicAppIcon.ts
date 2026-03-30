import { useEffect } from 'react';
import { Image as TauriImage } from '@tauri-apps/api/image';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Theme } from '../types/theme';
import { getDesktopPlatform } from '../utils/desktopPlatform';
import { isTauriEnvironment, windowSetMacosAppIcon } from '../services/tauriWindow';
import {
  buildWindowsDynamicAppIconSvg,
  MACOS_DYNAMIC_APP_ICON_SIZE,
  MACOS_DYNAMIC_APP_ICON_CORNER_RADIUS,
  MACOS_DYNAMIC_APP_ICON_LOGO_INSET,
  MACOS_DYNAMIC_APP_ICON_LOGO_SIZE,
  WINDOWS_DYNAMIC_APP_ICON_SIZE,
  type DynamicAppIconPlatform,
  deriveDynamicAppIconPalette,
  shouldUseMacosDynamicAppIcon,
} from './dynamicAppIconRenderer';

export interface DynamicAppIconSyncDeps {
  isTauriEnvironment: () => boolean;
  getPlatform: () => DynamicAppIconPlatform;
  renderWindowsAppIconPngBytes: (theme: Theme) => Promise<Uint8Array>;
  renderMacosAppIconPngBytes: (theme: Theme) => Promise<Uint8Array>;
  setWindowIconFromPng: (pngBytes: Uint8Array) => Promise<void>;
  setMacosAppIcon: (pngBytes: Uint8Array) => Promise<void>;
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

function traceRoundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));

  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function traceLogoPath(context: CanvasRenderingContext2D): void {
  context.beginPath();
  context.moveTo(21, 12);
  context.lineTo(4, 4);
  context.bezierCurveTo(6, 9, 6, 15, 4, 20);
  context.closePath();
}

async function renderMacosAppIconPngBytes(theme: Theme): Promise<Uint8Array> {
  const { canvas, context } = createIconCanvas(MACOS_DYNAMIC_APP_ICON_SIZE);
  const palette = deriveDynamicAppIconPalette(theme);
  const iconScale = MACOS_DYNAMIC_APP_ICON_SIZE / 1024;
  const logoInset = MACOS_DYNAMIC_APP_ICON_LOGO_INSET * iconScale;
  const logoSize = MACOS_DYNAMIC_APP_ICON_LOGO_SIZE * iconScale;
  const logoScale = logoSize / 24;

  context.clearRect(0, 0, MACOS_DYNAMIC_APP_ICON_SIZE, MACOS_DYNAMIC_APP_ICON_SIZE);
  context.imageSmoothingEnabled = true;

  traceRoundedRectPath(
    context,
    0,
    0,
    MACOS_DYNAMIC_APP_ICON_SIZE,
    MACOS_DYNAMIC_APP_ICON_SIZE,
    MACOS_DYNAMIC_APP_ICON_CORNER_RADIUS * iconScale
  );
  context.fillStyle = palette.backgroundColor;
  context.fill();

  context.save();
  context.translate(logoInset, logoInset);
  context.scale(logoScale, logoScale);

  const gradient = context.createLinearGradient(0, 0, 24, 24);
  gradient.addColorStop(0, palette.logoStartColor);
  gradient.addColorStop(1, palette.logoEndColor);

  context.translate(12, 12);
  context.rotate((-90 * Math.PI) / 180);
  context.translate(-12, -12);

  traceLogoPath(context);
  context.strokeStyle = gradient;
  context.lineWidth = 3;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.stroke();
  context.restore();

  return canvasToPngBytes(canvas);
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
  renderMacosAppIconPngBytes,
  setWindowIconFromPng,
  setMacosAppIcon: windowSetMacosAppIcon,
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
  const pngBytes = useMacosNativeIcon
    ? await deps.renderMacosAppIconPngBytes(theme)
    : await deps.renderWindowsAppIconPngBytes(theme);

  if (useMacosNativeIcon) {
    await deps.setMacosAppIcon(pngBytes);
    return;
  }

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
      setMacosAppIcon: async (pngBytes) => {
        if (cancelled) {
          return;
        }

        await defaultDynamicAppIconSyncDeps.setMacosAppIcon(pngBytes);
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
