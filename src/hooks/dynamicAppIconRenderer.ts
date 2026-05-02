export type DynamicLogoPlatform = 'macos' | 'windows' | 'linux' | 'web';

export interface DynamicLogoThemeColors {
  backgroundColor: string;
  primaryColor: string;
  themeType: 'light' | 'dark';
}

export interface DynamicLogoPalette {
  backgroundColor: string;
  logoStartColor: string;
  logoEndColor: string;
}

export const THEMED_LOGO_ICON_SIZE = 128;
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

export function buildThemedLogoSvg(
  logoSvgSource: string,
  palette: DynamicLogoPalette
): string {
  return logoSvgSource
    .replaceAll('#3B82F6', palette.logoStartColor)
    .replaceAll('#1E40AF', palette.logoEndColor)
    .replaceAll(DEFAULT_LOGO_START_COLOR, palette.logoStartColor)
    .replaceAll(DEFAULT_LOGO_END_COLOR, palette.logoEndColor);
}

export function deriveDynamicLogoPalette(colors: DynamicLogoThemeColors): DynamicLogoPalette {
  const logoStartColor = normalizeHex(colors.primaryColor);

  return {
    backgroundColor: normalizeHex(colors.backgroundColor),
    logoStartColor,
    logoEndColor: mixHex(logoStartColor, '#000000', 0.2),
  };
}

export function buildMacosDynamicAppIconThemeSpec(
  colors: DynamicLogoThemeColors
): MacosDynamicAppIconThemeSpec {
  return deriveDynamicLogoPalette(colors);
}

export function buildThemedLogoDataUrl(themedLogoSvg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themedLogoSvg)}`;
}

export function shouldUseMacosNativeLogoIcon({
  isTauriEnvironment,
  platform,
}: {
  isTauriEnvironment: boolean;
  platform: DynamicLogoPlatform;
}): boolean {
  return isTauriEnvironment && platform === 'macos';
}
