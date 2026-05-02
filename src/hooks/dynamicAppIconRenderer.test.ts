import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveDynamicLogoPalette,
  buildThemedLogoDataUrl,
  buildThemedLogoSvg,
  buildMacosDynamicAppIconThemeSpec,
  type DynamicLogoThemeColors,
  shouldUseMacosNativeLogoIcon,
} from './dynamicAppIconRenderer';

const publicLogoSvg = readFileSync(join(process.cwd(), 'public', 'logo.svg'), 'utf8');

const darkThemeColors: DynamicLogoThemeColors = {
  backgroundColor: '#09090B',
  primaryColor: '#6366F1',
  themeType: 'dark',
};

const lightThemeColors: DynamicLogoThemeColors = {
  backgroundColor: '#ffffff',
  primaryColor: '#f97316',
  themeType: 'light',
};

describe('dynamicAppIconRenderer', () => {
  it('derives the app icon palette from the exact theme background and primary color', () => {
    const palette = deriveDynamicLogoPalette(darkThemeColors);

    expect(palette.backgroundColor).toBe('#09090b');
    expect(palette.logoStartColor).toBe('#6366f1');
    expect(palette.logoEndColor).toBe('#4f52c1');
  });

  it('builds the macOS theme spec from the resolved theme colors', () => {
    const spec = buildMacosDynamicAppIconThemeSpec(darkThemeColors);

    expect(spec).toEqual({
      backgroundColor: '#09090b',
      logoStartColor: '#6366f1',
      logoEndColor: '#4f52c1',
    });
  });

  it('keeps the Windows-style icon transparent behind the logo', () => {
    const svg = buildThemedLogoSvg(
      publicLogoSvg,
      deriveDynamicLogoPalette(darkThemeColors)
    );

    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).not.toContain('<rect');
    expect(svg).toContain('stop-color="#6366f1"');
    expect(svg).toContain('stop-color="#4f52c1"');
  });

  it('preserves the public logo shape while replacing only theme colors', () => {
    const svg = buildThemedLogoSvg(
      publicLogoSvg,
      deriveDynamicLogoPalette(darkThemeColors)
    );

    expect(svg).toContain('d="M21 12L4 4C6 9 6 15 4 20L21 12Z"');
    expect(svg).toContain('stroke-width:2.4375');
    expect(svg).toContain('transform="rotate(-90 12 12)"');
    expect(svg).not.toContain('#3B82F6');
    expect(svg).not.toContain('#1E40AF');
    expect(svg).toContain('stop-color="#6366f1"');
    expect(svg).toContain('stop-color="#4f52c1"');
  });

  it('builds different icon SVG colors for different theme primary colors', () => {
    const darkSvg = buildThemedLogoSvg(
      publicLogoSvg,
      deriveDynamicLogoPalette(darkThemeColors)
    );
    const lightSvg = buildThemedLogoSvg(
      publicLogoSvg,
      deriveDynamicLogoPalette(lightThemeColors)
    );

    expect(darkSvg).not.toBe(lightSvg);
    expect(lightSvg).toContain('stop-color="#f97316"');
    expect(lightSvg).toContain('stop-color="#c75c12"');
  });

  it('builds a favicon-safe SVG data URL from a themed logo', () => {
    const svg = buildThemedLogoSvg(
      publicLogoSvg,
      deriveDynamicLogoPalette(darkThemeColors)
    );
    const dataUrl = buildThemedLogoDataUrl(svg);

    expect(dataUrl).toStartWith('data:image/svg+xml;charset=utf-8,');
    expect(decodeURIComponent(dataUrl)).toContain('stop-color="#6366f1"');
  });

  it('uses the native macOS icon bridge only in Tauri on macOS', () => {
    expect(
      shouldUseMacosNativeLogoIcon({ isTauriEnvironment: true, platform: 'macos' })
    ).toBe(true);
    expect(
      shouldUseMacosNativeLogoIcon({ isTauriEnvironment: true, platform: 'windows' })
    ).toBe(false);
    expect(
      shouldUseMacosNativeLogoIcon({ isTauriEnvironment: false, platform: 'macos' })
    ).toBe(false);
  });
});
