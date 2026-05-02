import { useEffect, useMemo } from 'react';
import { Image as TauriImage } from '@tauri-apps/api/image';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Theme } from '../types/theme';
import { getDesktopPlatform } from '../utils/desktopPlatform';
import { isTauriEnvironment, windowSetMacosAppIconTheme } from '../services/tauriWindow';
import {
  buildThemedLogoDataUrl,
  buildThemedLogoSvg,
  deriveDynamicLogoPalette,
  THEMED_LOGO_ICON_SIZE,
  buildMacosDynamicAppIconThemeSpec,
  type DynamicLogoPlatform,
  type DynamicLogoThemeColors,
  type MacosDynamicAppIconThemeSpec,
  shouldUseMacosNativeLogoIcon,
} from './dynamicAppIconRenderer';

export const PUBLIC_LOGO_URL = '/logo.svg';

export type DynamicLogoSyncStatus = 'updated' | 'skipped' | 'failed';
export type DynamicLogoSurface = 'favicon' | 'nativeIcon';

export interface DynamicLogoSurfaceResult {
  surface: DynamicLogoSurface;
  status: DynamicLogoSyncStatus;
  reason?: string;
}

export interface DynamicLogoSyncResult {
  favicon: DynamicLogoSurfaceResult;
  nativeIcon: DynamicLogoSurfaceResult;
}

export interface DynamicLogoSyncDeps {
  isTauriEnvironment: () => boolean;
  getPlatform: () => DynamicLogoPlatform;
  renderThemedLogoPngBytes: (themedLogoSvg: string) => Promise<Uint8Array>;
  loadLogoSvgSource: () => Promise<string>;
  buildMacosAppIconThemeSpec: (colors: DynamicLogoThemeColors) => MacosDynamicAppIconThemeSpec;
  setFaviconFromSvg: (themedLogoSvg: string) => void;
  setWindowIconFromPng: (pngBytes: Uint8Array) => Promise<void>;
  setMacosAppIconTheme: (spec: MacosDynamicAppIconThemeSpec) => Promise<void>;
  logDynamicLogoWarning: (message: string, error?: unknown) => void;
}

function buildDynamicLogoThemeColors({
  backgroundColor,
  primaryColor,
  themeType,
}: {
  backgroundColor: string;
  primaryColor: string;
  themeType: Theme['type'];
}): DynamicLogoThemeColors {
  return {
    backgroundColor,
    primaryColor,
    themeType,
  };
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

let logoSvgSourcePromise: Promise<string> | null = null;
let windowsTaskbarLimitLogged = false;

async function loadLogoSvgSource(): Promise<string> {
  logoSvgSourcePromise ??= fetch(PUBLIC_LOGO_URL).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load logo SVG: ${response.status}`);
    }

    return response.text();
  });

  return logoSvgSourcePromise;
}

async function renderThemedLogoPngBytes(themedLogoSvg: string): Promise<Uint8Array> {
  return renderSvgToPngBytes(themedLogoSvg, THEMED_LOGO_ICON_SIZE);
}

function findOrCreateFaviconLink(): HTMLLinkElement {
  const existingLink = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (existingLink) {
    return existingLink;
  }

  const link = document.createElement('link');
  link.rel = 'icon';
  document.head.appendChild(link);
  return link;
}

function setFaviconFromSvg(themedLogoSvg: string): void {
  const link = findOrCreateFaviconLink();
  link.type = 'image/svg+xml';
  link.href = buildThemedLogoDataUrl(themedLogoSvg);
}

async function setWindowIconFromPng(pngBytes: Uint8Array): Promise<void> {
  const icon = await TauriImage.fromBytes(pngBytes);
  await getCurrentWindow().setIcon(icon);
}

function logDynamicLogoWarning(message: string, error?: unknown): void {
  if (error === undefined) {
    console.warn(`[dynamicLogo] ${message}`);
    return;
  }

  console.warn(`[dynamicLogo] ${message}`, error);
}

const defaultDynamicLogoSyncDeps: DynamicLogoSyncDeps = {
  isTauriEnvironment,
  getPlatform: getDesktopPlatform,
  renderThemedLogoPngBytes,
  loadLogoSvgSource,
  buildMacosAppIconThemeSpec: buildMacosDynamicAppIconThemeSpec,
  setFaviconFromSvg,
  setWindowIconFromPng,
  setMacosAppIconTheme: windowSetMacosAppIconTheme,
  logDynamicLogoWarning,
};

export async function syncDynamicAppIcon(
  colors: DynamicLogoThemeColors,
  deps: DynamicLogoSyncDeps = defaultDynamicLogoSyncDeps
): Promise<DynamicLogoSyncResult> {
  const result: DynamicLogoSyncResult = {
    favicon: {
      surface: 'favicon',
      status: 'skipped',
    },
    nativeIcon: {
      surface: 'nativeIcon',
      status: 'skipped',
    },
  };
  let logoSvgSource: string;

  try {
    logoSvgSource = await deps.loadLogoSvgSource();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.logDynamicLogoWarning('Failed to load the public logo SVG.', error);
    return {
      favicon: {
        surface: 'favicon',
        status: 'failed',
        reason,
      },
      nativeIcon: {
        surface: 'nativeIcon',
        status: 'failed',
        reason,
      },
    };
  }

  const themedLogoSvg = buildThemedLogoSvg(logoSvgSource, deriveDynamicLogoPalette(colors));

  try {
    deps.setFaviconFromSvg(themedLogoSvg);
    result.favicon = {
      surface: 'favicon',
      status: 'updated',
    };
  } catch (error) {
    deps.logDynamicLogoWarning('Failed to update themed favicon.', error);
    result.favicon = {
      surface: 'favicon',
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const tauriAvailable = deps.isTauriEnvironment();
  if (!tauriAvailable) {
    result.nativeIcon = {
      surface: 'nativeIcon',
      status: 'skipped',
      reason: 'not-tauri',
    };
    return result;
  }

  const platform = deps.getPlatform();
  const useMacosNativeIcon = shouldUseMacosNativeLogoIcon({
    isTauriEnvironment: tauriAvailable,
    platform,
  });

  if (useMacosNativeIcon) {
    try {
      await deps.setMacosAppIconTheme(deps.buildMacosAppIconThemeSpec(colors));
      result.nativeIcon = {
        surface: 'nativeIcon',
        status: 'updated',
      };
    } catch (error) {
      deps.logDynamicLogoWarning('Failed to update the native macOS app icon.', error);
      result.nativeIcon = {
        surface: 'nativeIcon',
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return result;
  }

  try {
    const pngBytes = await deps.renderThemedLogoPngBytes(themedLogoSvg);
    await deps.setWindowIconFromPng(pngBytes);
    result.nativeIcon = {
      surface: 'nativeIcon',
      status: 'updated',
      reason: platform === 'windows' ? 'windows-taskbar-best-effort' : undefined,
    };
    if (platform === 'windows') {
      if (!windowsTaskbarLimitLogged) {
        windowsTaskbarLimitLogged = true;
        deps.logDynamicLogoWarning(
          'Updated the native window icon. Windows 11 may keep showing the pinned taskbar icon from its shell cache.'
        );
      }
    }
  } catch (error) {
    deps.logDynamicLogoWarning('Failed to update the native window icon.', error);
    result.nativeIcon = {
      surface: 'nativeIcon',
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return result;
}

export function useDynamicAppIcon(theme: Theme, enabled = true): void {
  const backgroundColor = theme.colors.background;
  const primaryColor = theme.colors.primary;
  const themeType = theme.type;
  const logoColors = useMemo(
    () => buildDynamicLogoThemeColors({ backgroundColor, primaryColor, themeType }),
    [backgroundColor, primaryColor, themeType]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const guardedDeps: DynamicLogoSyncDeps = {
      ...defaultDynamicLogoSyncDeps,
      setFaviconFromSvg: (themedLogoSvg) => {
        if (cancelled) {
          return;
        }

        defaultDynamicLogoSyncDeps.setFaviconFromSvg(themedLogoSvg);
      },
      setWindowIconFromPng: async (pngBytes) => {
        if (cancelled) {
          return;
        }

        await defaultDynamicLogoSyncDeps.setWindowIconFromPng(pngBytes);
      },
      setMacosAppIconTheme: async (spec) => {
        if (cancelled) {
          return;
        }

        await defaultDynamicLogoSyncDeps.setMacosAppIconTheme(spec);
      },
    };

    void syncDynamicAppIcon(logoColors, guardedDeps).catch((error) => {
      if (!cancelled) {
        console.error('Error updating app icon:', error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, logoColors]);
}
