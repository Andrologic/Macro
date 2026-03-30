import { isTauriEnvironment } from './isTauriEnvironment';

export type DesktopPlatform = 'macos' | 'windows' | 'linux' | 'web';

export interface PlatformChromeState {
  platform: DesktopPlatform;
  isTauriWindow: boolean;
  showCustomWindowControls: boolean;
  disableCustomDoubleClickZoom: boolean;
  usesNativeMacosTitlebar: boolean;
}

const getNavigatorPlatformHint = (): string => {
  if (typeof navigator === 'undefined') {
    return '';
  }

  const candidate =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent;

  return candidate.toLowerCase();
};

export function getDesktopPlatform(): DesktopPlatform {
  const platformHint = getNavigatorPlatformHint();

  if (platformHint.includes('mac')) {
    return 'macos';
  }

  if (platformHint.includes('win')) {
    return 'windows';
  }

  if (
    platformHint.includes('linux') ||
    platformHint.includes('x11') ||
    platformHint.includes('wayland')
  ) {
    return 'linux';
  }

  return 'web';
}

export function resolvePlatformChromeState({
  platform = getDesktopPlatform(),
  tauriWindow = isTauriEnvironment(),
}: {
  platform?: DesktopPlatform;
  tauriWindow?: boolean;
} = {}): PlatformChromeState {
  const usesNativeMacosTitlebar = tauriWindow && platform === 'macos';

  return {
    platform,
    isTauriWindow: tauriWindow,
    showCustomWindowControls: tauriWindow && platform !== 'macos',
    disableCustomDoubleClickZoom: usesNativeMacosTitlebar,
    usesNativeMacosTitlebar,
  };
}

export function getPlatformChromeState(): PlatformChromeState {
  return resolvePlatformChromeState();
}
