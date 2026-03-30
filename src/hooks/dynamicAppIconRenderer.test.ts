import { describe, expect, it } from 'bun:test';
import type { Theme } from '../types/theme';
import {
  deriveDynamicAppIconPalette,
  buildMacosDynamicAppIconSvg,
  buildWindowsDynamicAppIconSvg,
  shouldUseMacosDynamicAppIcon,
  MACOS_DYNAMIC_APP_ICON_CORNER_RADIUS,
  MACOS_DYNAMIC_APP_ICON_LOGO_INSET,
  MACOS_DYNAMIC_APP_ICON_LOGO_SIZE,
} from './dynamicAppIconRenderer';

const darkTheme: Theme = {
  name: 'Macro Dark',
  type: 'dark',
  colors: {
    background: '#09090B',
    foreground: '#fafafa',
    card: '#09090b',
    cardForeground: '#fafafa',
    popover: '#111117',
    popoverForeground: '#fafafa',
    primary: '#6366F1',
    primaryForeground: '#fafafa',
    secondary: '#27272a',
    secondaryForeground: '#fafafa',
    muted: '#27272a',
    mutedForeground: '#a1a1aa',
    accent: '#27272a',
    accentForeground: '#fafafa',
    destructive: '#ef4444',
    destructiveForeground: '#fafafa',
    border: '#27272a',
    input: '#27272a',
    ring: '#6366f1',
  },
};

describe('dynamicAppIconRenderer', () => {
  it('derives the app icon palette from the exact theme background and primary color', () => {
    const palette = deriveDynamicAppIconPalette(darkTheme);

    expect(palette.backgroundColor).toBe('#09090b');
    expect(palette.logoStartColor).toBe('#6366f1');
    expect(palette.logoEndColor).toBe('#4f52c1');
  });

  it('builds the macOS SVG with the expected Apple-style surface and logo inset', () => {
    const svg = buildMacosDynamicAppIconSvg(darkTheme);

    expect(svg).toContain(`rx="${MACOS_DYNAMIC_APP_ICON_CORNER_RADIUS}"`);
    expect(svg).toContain('fill="#09090b"');
    expect(svg).toContain(`x="${MACOS_DYNAMIC_APP_ICON_LOGO_INSET}"`);
    expect(svg).toContain(`width="${MACOS_DYNAMIC_APP_ICON_LOGO_SIZE}"`);
  });

  it('keeps the Windows-style icon transparent behind the logo', () => {
    const svg = buildWindowsDynamicAppIconSvg(darkTheme);

    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).not.toContain('<rect');
    expect(svg).toContain('stroke="url(#dynamic-app-icon-grad)"');
  });

  it('uses the native macOS icon bridge only in Tauri on macOS', () => {
    expect(
      shouldUseMacosDynamicAppIcon({ isTauriEnvironment: true, platform: 'macos' })
    ).toBe(true);
    expect(
      shouldUseMacosDynamicAppIcon({ isTauriEnvironment: true, platform: 'windows' })
    ).toBe(false);
    expect(
      shouldUseMacosDynamicAppIcon({ isTauriEnvironment: false, platform: 'macos' })
    ).toBe(false);
  });
});
