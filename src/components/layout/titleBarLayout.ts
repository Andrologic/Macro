import type { DesktopPlatform, PlatformChromeState } from '../../utils/desktopPlatform';

export const DEFAULT_TITLE_BAR_HEIGHT_PX = 48;
export const MACOS_NATIVE_TITLE_BAR_HEIGHT_PX = 56;
export const MACOS_TRAFFIC_LIGHT_POSITION = {
  x: 18,
  y: 18,
} as const;

export interface TitleBarLayout {
  titleBarHeightPx: number;
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
