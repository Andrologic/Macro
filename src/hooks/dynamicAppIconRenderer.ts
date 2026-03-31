import logoSvgSource from '../assets/logo.svg?raw';
import type { Theme } from '../types/theme';

export type DynamicAppIconPlatform = 'macos' | 'windows' | 'linux' | 'web';

export interface DynamicAppIconPalette {
  backgroundColor: string;
  logoStartColor: string;
  logoEndColor: string;
}

export const WINDOWS_DYNAMIC_APP_ICON_SIZE = 128;
const DEFAULT_LOGO_START_COLOR = '#3b82f6';
const DEFAULT_LOGO_END_COLOR = '#1e40af';

export interface MacosDynamicAppIconThemeSpec {
  backgroundColor: string;
  logoStartColor: string;
  logoEndColor: string;
}

function normalizeHex(hex: string): string {
  const sanitized = hex.trim().replace('#', '');
  if (sanitized.length === 3) {
    return `#${sanitized
      .split('')
      .map((char) => `${char}${char}`)
      .join('')}`.toLowerCase();
  }

  return `#${sanitized.slice(0, 6)}`.toLowerCase();
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const normalized = normalizeHex(hex).replace('#', '');

  return {
    red: parseInt(normalized.slice(0, 2), 16),
    green: parseInt(normalized.slice(2, 4), 16),
    blue: parseInt(normalized.slice(4, 6), 16),
  };
}

function toHexChannel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}

function mixHex(sourceHex: string, targetHex: string, weight: number): string {
  const source = hexToRgb(sourceHex);
  const target = hexToRgb(targetHex);
  const clampedWeight = Math.max(0, Math.min(1, weight));

  return `#${toHexChannel(source.red + (target.red - source.red) * clampedWeight)}${toHexChannel(
    source.green + (target.green - source.green) * clampedWeight
  )}${toHexChannel(source.blue + (target.blue - source.blue) * clampedWeight)}`;
}

function buildThemedLogoSvg(palette: DynamicAppIconPalette): string {
  return logoSvgSource
    .replaceAll('#3B82F6', palette.logoStartColor)
    .replaceAll('#1E40AF', palette.logoEndColor)
    .replaceAll(DEFAULT_LOGO_START_COLOR, palette.logoStartColor)
    .replaceAll(DEFAULT_LOGO_END_COLOR, palette.logoEndColor);
}

export function deriveDynamicAppIconPalette(theme: Theme): DynamicAppIconPalette {
  const logoStartColor = normalizeHex(theme.colors.primary);

  return {
    backgroundColor: normalizeHex(theme.colors.background),
    logoStartColor,
    logoEndColor: mixHex(logoStartColor, '#000000', 0.2),
  };
}

export function buildWindowsDynamicAppIconSvg(theme: Theme): string {
  return buildThemedLogoSvg(deriveDynamicAppIconPalette(theme));
}

export function buildMacosDynamicAppIconThemeSpec(theme: Theme): MacosDynamicAppIconThemeSpec {
  return deriveDynamicAppIconPalette(theme);
}

export function shouldUseMacosDynamicAppIcon({
  isTauriEnvironment,
  platform,
}: {
  isTauriEnvironment: boolean;
  platform: DynamicAppIconPlatform;
}): boolean {
  return isTauriEnvironment && platform === 'macos';
}
