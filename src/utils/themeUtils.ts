import { Theme } from '../types/theme';

export interface TitlebarThemeTokens {
  backgroundStart: string;
  backgroundMid: string;
  backgroundEnd: string;
  border: string;
  highlight: string;
  controlBackground: string;
  controlBorder: string;
  nativeWindowBackground: string;
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

function hexToRgbObject(hex: string): { red: number; green: number; blue: number } {
  const normalized = normalizeHex(hex).replace('#', '');

  return {
    red: parseInt(normalized.substring(0, 2), 16),
    green: parseInt(normalized.substring(2, 4), 16),
    blue: parseInt(normalized.substring(4, 6), 16),
  };
}

function toHexChannel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

function rgbObjectToHex({
  red,
  green,
  blue,
}: {
  red: number;
  green: number;
  blue: number;
}): string {
  return `#${toHexChannel(red)}${toHexChannel(green)}${toHexChannel(blue)}`;
}

function mixHex(hex: string, targetHex: string, weight: number): string {
  const source = hexToRgbObject(hex);
  const target = hexToRgbObject(targetHex);
  const clampedWeight = Math.max(0, Math.min(1, weight));

  return rgbObjectToHex({
    red: source.red + (target.red - source.red) * clampedWeight,
    green: source.green + (target.green - source.green) * clampedWeight,
    blue: source.blue + (target.blue - source.blue) * clampedWeight,
  });
}

function withAlpha(hex: string, alpha: number): string {
  const { red, green, blue } = hexToRgbObject(hex);
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

export function hexToRgb(hex: string): string {
  const { red, green, blue } = hexToRgbObject(hex);
  return `${red} ${green} ${blue}`;
}

export function deriveTitlebarTheme(theme: Theme): TitlebarThemeTokens {
  const baseBackground = normalizeHex(theme.colors.background);
  const isDark = theme.type === 'dark';

  const backgroundStart = isDark
    ? mixHex(baseBackground, '#ffffff', 0.08)
    : mixHex(baseBackground, '#ffffff', 0.16);
  const backgroundMid = isDark
    ? mixHex(baseBackground, '#ffffff', 0.04)
    : mixHex(baseBackground, '#ffffff', 0.08);
  const backgroundEnd = isDark
    ? mixHex(baseBackground, '#000000', 0.1)
    : mixHex(baseBackground, '#000000', 0.04);
  const borderBase = isDark
    ? mixHex(baseBackground, '#ffffff', 0.3)
    : mixHex(baseBackground, '#000000', 0.26);
  const controlBase = isDark
    ? mixHex(baseBackground, '#ffffff', 0.18)
    : mixHex(baseBackground, '#ffffff', 0.24);

  return {
    backgroundStart,
    backgroundMid,
    backgroundEnd,
    border: withAlpha(borderBase, isDark ? 0.34 : 0.18),
    highlight: isDark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.42)',
    controlBackground: withAlpha(controlBase, isDark ? 0.76 : 0.82),
    controlBorder: withAlpha(borderBase, isDark ? 0.3 : 0.14),
    nativeWindowBackground: backgroundMid,
  };
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const titlebarTheme = deriveTitlebarTheme(theme);

  if (theme.type === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  const setRgbVar = (name: string, hex: string) => {
    root.style.setProperty(`--${name}`, hexToRgb(hex));
  };

  setRgbVar('background', theme.colors.background);
  setRgbVar('foreground', theme.colors.foreground);
  setRgbVar('card', theme.colors.card);
  setRgbVar('card-foreground', theme.colors.cardForeground);
  setRgbVar('popover', theme.colors.popover);
  setRgbVar('popover-foreground', theme.colors.popoverForeground);
  setRgbVar('primary', theme.colors.primary);
  setRgbVar('primary-foreground', theme.colors.primaryForeground);
  setRgbVar('secondary', theme.colors.secondary);
  setRgbVar('secondary-foreground', theme.colors.secondaryForeground);
  setRgbVar('muted', theme.colors.muted);
  setRgbVar('muted-foreground', theme.colors.mutedForeground);
  setRgbVar('accent', theme.colors.accent);
  setRgbVar('accent-foreground', theme.colors.accentForeground);
  setRgbVar('destructive', theme.colors.destructive);
  setRgbVar('destructive-foreground', theme.colors.destructiveForeground);
  setRgbVar('border', theme.colors.border);
  setRgbVar('input', theme.colors.input);
  setRgbVar('ring', theme.colors.ring);

  root.style.setProperty('--macro-titlebar-bg-start', titlebarTheme.backgroundStart);
  root.style.setProperty('--macro-titlebar-bg-mid', titlebarTheme.backgroundMid);
  root.style.setProperty('--macro-titlebar-bg-end', titlebarTheme.backgroundEnd);
  root.style.setProperty('--macro-titlebar-border', titlebarTheme.border);
  root.style.setProperty('--macro-titlebar-highlight', titlebarTheme.highlight);
  root.style.setProperty('--macro-titlebar-control-bg', titlebarTheme.controlBackground);
  root.style.setProperty('--macro-titlebar-control-border', titlebarTheme.controlBorder);
}
