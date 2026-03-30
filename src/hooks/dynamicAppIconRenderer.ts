import type { Theme } from '../types/theme';

export type DynamicAppIconPlatform = 'macos' | 'windows' | 'linux' | 'web';

export interface DynamicAppIconPalette {
  backgroundColor: string;
  logoStartColor: string;
  logoEndColor: string;
}

export const WINDOWS_DYNAMIC_APP_ICON_SIZE = 128;
export const MACOS_DYNAMIC_APP_ICON_SIZE = 1024;
export const MACOS_DYNAMIC_APP_ICON_CORNER_RADIUS = 235;
export const MACOS_DYNAMIC_APP_ICON_LOGO_SIZE = 862;
export const MACOS_DYNAMIC_APP_ICON_LOGO_INSET = 81;

const LOGO_GRADIENT_ID = 'dynamic-app-icon-grad';
const LOGO_PATH = 'M 21,12 4,4 c 2,5 2,11 0,16 z';
const LOGO_STROKE_WIDTH = 3;

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

function buildLogoMarkup(palette: DynamicAppIconPalette): string {
  return `
    <defs>
      <linearGradient id="${LOGO_GRADIENT_ID}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${palette.logoStartColor}" />
        <stop offset="100%" stop-color="${palette.logoEndColor}" />
      </linearGradient>
    </defs>
    <g transform="rotate(-90 12 12)">
      <path
        d="${LOGO_PATH}"
        stroke="url(#${LOGO_GRADIENT_ID})"
        stroke-width="${LOGO_STROKE_WIDTH}"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </g>
  `;
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
  const palette = deriveDynamicAppIconPalette(theme);

  return `
    <svg
      width="${WINDOWS_DYNAMIC_APP_ICON_SIZE}"
      height="${WINDOWS_DYNAMIC_APP_ICON_SIZE}"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      ${buildLogoMarkup(palette)}
    </svg>
  `.trim();
}

export function buildMacosDynamicAppIconSvg(theme: Theme): string {
  const palette = deriveDynamicAppIconPalette(theme);

  return `
    <svg
      width="${MACOS_DYNAMIC_APP_ICON_SIZE}"
      height="${MACOS_DYNAMIC_APP_ICON_SIZE}"
      viewBox="0 0 ${MACOS_DYNAMIC_APP_ICON_SIZE} ${MACOS_DYNAMIC_APP_ICON_SIZE}"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        width="${MACOS_DYNAMIC_APP_ICON_SIZE}"
        height="${MACOS_DYNAMIC_APP_ICON_SIZE}"
        rx="${MACOS_DYNAMIC_APP_ICON_CORNER_RADIUS}"
        fill="${palette.backgroundColor}"
      />
      <svg
        x="${MACOS_DYNAMIC_APP_ICON_LOGO_INSET}"
        y="${MACOS_DYNAMIC_APP_ICON_LOGO_INSET}"
        width="${MACOS_DYNAMIC_APP_ICON_LOGO_SIZE}"
        height="${MACOS_DYNAMIC_APP_ICON_LOGO_SIZE}"
        viewBox="0 0 24 24"
        fill="none"
      >
        ${buildLogoMarkup(palette)}
      </svg>
    </svg>
  `.trim();
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
