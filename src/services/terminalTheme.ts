import type { ITheme } from 'xterm';
import type { Theme } from '../types/theme';

const FALLBACK_THEME: Theme = {
  name: 'Macro Dark',
  type: 'dark',
  colors: {
    background: '#09090b',
    foreground: '#fafafa',
    card: '#09090b',
    cardForeground: '#fafafa',
    popover: '#09090b',
    popoverForeground: '#fafafa',
    primary: '#6366f1',
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

const ANSI_DARK = {
  black: '#18181b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#71717a',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

const ANSI_LIGHT = {
  black: '#27272a',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#1d4ed8',
  magenta: '#7e22ce',
  cyan: '#0e7490',
  white: '#f4f4f5',
  brightBlack: '#71717a',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#2563eb',
  brightMagenta: '#9333ea',
  brightCyan: '#0891b2',
  brightWhite: '#ffffff',
};

const normalizeHex = (hex: string | null | undefined, fallback: string): string => {
  const raw = (hex || '').trim();
  if (!raw.startsWith('#')) {
    return fallback;
  }

  const sanitized = raw.slice(1);
  if (/^[0-9a-f]{3}$/i.test(sanitized)) {
    return `#${sanitized
      .split('')
      .map((char) => `${char}${char}`)
      .join('')}`.toLowerCase();
  }

  if (/^[0-9a-f]{6}$/i.test(sanitized)) {
    return `#${sanitized}`.toLowerCase();
  }

  return fallback;
};

const hexToRgb = (hex: string): { red: number; green: number; blue: number } => {
  const normalized = normalizeHex(hex, '#000000').slice(1);
  return {
    red: parseInt(normalized.slice(0, 2), 16),
    green: parseInt(normalized.slice(2, 4), 16),
    blue: parseInt(normalized.slice(4, 6), 16),
  };
};

const withAlpha = (hex: string, alpha: number): string => {
  const { red, green, blue } = hexToRgb(hex);
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
};

export const buildTerminalTheme = (theme?: Theme | null): ITheme => {
  const resolvedTheme = theme ?? FALLBACK_THEME;
  const colors = resolvedTheme.colors;
  const isDark = resolvedTheme.type === 'dark';
  const ansi = isDark ? ANSI_DARK : ANSI_LIGHT;
  const background = normalizeHex(colors.background, FALLBACK_THEME.colors.background);
  const foreground = normalizeHex(colors.foreground, FALLBACK_THEME.colors.foreground);
  const primary = normalizeHex(colors.primary, FALLBACK_THEME.colors.primary);
  const cursor = normalizeHex(colors.ring || colors.primary, primary);
  const mutedForeground = normalizeHex(colors.mutedForeground, ansi.brightBlack);

  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    selectionBackground: withAlpha(primary, isDark ? 0.28 : 0.2),
    selectionForeground: foreground,
    black: ansi.black,
    red: normalizeHex(colors.destructive, ansi.red),
    green: ansi.green,
    yellow: ansi.yellow,
    blue: primary || ansi.blue,
    magenta: normalizeHex(colors.accent, ansi.magenta),
    cyan: ansi.cyan,
    white: ansi.white,
    brightBlack: mutedForeground,
    brightRed: ansi.brightRed,
    brightGreen: ansi.brightGreen,
    brightYellow: ansi.brightYellow,
    brightBlue: ansi.brightBlue,
    brightMagenta: ansi.brightMagenta,
    brightCyan: ansi.brightCyan,
    brightWhite: normalizeHex(colors.cardForeground || colors.foreground, ansi.brightWhite),
  };
};

export const getTerminalThemeSignature = (theme?: Theme | null): string =>
  JSON.stringify(buildTerminalTheme(theme));

export const __testables = {
  FALLBACK_THEME,
  normalizeHex,
  withAlpha,
};
