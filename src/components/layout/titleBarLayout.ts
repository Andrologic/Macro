import type { DesktopPlatform, PlatformChromeState } from '../../utils/desktopPlatform';

export const DEFAULT_TITLE_BAR_HEIGHT_PX = 48;
export const MACOS_NATIVE_TITLE_BAR_HEIGHT_PX = 56;
export const MACOS_TRAFFIC_LIGHT_POSITION = {
  x: 15,
  y: 30,
} as const;

export interface TitleBarLayout {
  titleBarHeightPx: number;
}

export interface MacosTrafficLightPosition {
  x: number;
  y: number;
}

type TitleBarLayoutInput =
  | DesktopPlatform
  | Pick<PlatformChromeState, 'platform' | 'usesNativeMacosTitlebar'>;

function resolvePlatform(input: TitleBarLayoutInput): DesktopPlatform {
  return typeof input === 'string' ? input : input.platform;
}

function usesNativeMacosTitlebar(input: TitleBarLayoutInput): boolean {
  return typeof input === 'string'
    ? input === 'macos'
    : input.usesNativeMacosTitlebar;
}

export function shouldRenderCustomWindowControls(platform: DesktopPlatform): boolean {
  return platform !== 'macos' && platform !== 'web';
}

export function shouldToggleTitleBarDoubleClick(platform: DesktopPlatform): boolean {
  return platform !== 'macos';
}

export function getTitleBarLayout(input: TitleBarLayoutInput): TitleBarLayout {
  const platform = resolvePlatform(input);
  const nativeMacosTitlebar = usesNativeMacosTitlebar(input);

  return {
    titleBarHeightPx:
      platform === 'macos' && nativeMacosTitlebar
        ? MACOS_NATIVE_TITLE_BAR_HEIGHT_PX
        : DEFAULT_TITLE_BAR_HEIGHT_PX,
  };
}

export function getMacosTrafficLightPosition(
  scale: number
): MacosTrafficLightPosition {
  const resolvedScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  return {
    x: Math.max(0, Math.round(MACOS_TRAFFIC_LIGHT_POSITION.x * resolvedScale)),
    y: Math.max(0, Math.round(MACOS_TRAFFIC_LIGHT_POSITION.y * resolvedScale)),
  };
}
