import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  getTitleBarLayout,
} from './titleBarLayout';
const actualDesktopPlatform = await import('../../utils/desktopPlatform');

type TauriWindowState = {
  isAvailable: boolean;
  isMaximized: boolean;
  minimize: () => void;
  maximize: () => void;
  unmaximize: () => void;
  close: () => void;
};

let tauriWindowState: TauriWindowState;
let chromeState: {
  platform: 'macos' | 'windows' | 'linux' | 'web';
  isTauriWindow: boolean;
  showCustomWindowControls: boolean;
  disableCustomDoubleClickZoom: boolean;
  usesNativeMacosTitlebar: boolean;
};

mock.module('../../hooks/useTauriWindow', () => ({
  useTauriWindow: () => tauriWindowState,
}));

mock.module('../../utils/desktopPlatform', () => ({
  ...actualDesktopPlatform,
  getPlatformChromeState: () => chromeState,
}));

mock.module('../../i18n', () => ({
  default: {
    t: (_key: string, fallback: string) => fallback,
  },
}));

mock.module('../ui/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

const { WindowControls } = await import('./WindowControls');

describe('WindowControls', () => {
  beforeEach(() => {
    tauriWindowState = {
      isAvailable: true,
      isMaximized: false,
      minimize: () => undefined,
      maximize: () => undefined,
      unmaximize: () => undefined,
      close: () => undefined,
    };
    chromeState = {
      platform: 'windows',
      isTauriWindow: true,
      showCustomWindowControls: true,
      disableCustomDoubleClickZoom: false,
      usesNativeMacosTitlebar: false,
    };
  });

  it('renders custom controls on non-mac desktop platforms', async () => {
    const html = renderToStaticMarkup(<WindowControls />);

    expect(html).toContain('button');
  });

  it('hides custom controls on macOS', async () => {
    chromeState = {
      platform: 'macos',
      isTauriWindow: true,
      showCustomWindowControls: false,
      disableCustomDoubleClickZoom: true,
      usesNativeMacosTitlebar: true,
    };

    const html = renderToStaticMarkup(<WindowControls />);

    expect(html).toBe('');
  });

  it('keeps the platform contract explicit', () => {
    expect(
      getTitleBarLayout({ platform: 'macos', usesNativeMacosTitlebar: true })
    ).toEqual({
      titleBarHeightPx: 56,
    });
  });
});
