import { describe, expect, it } from 'bun:test';
import type { Theme } from '../types/theme';
import { buildTerminalTheme } from './terminalTheme';

const macroDarkTheme: Theme = {
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

const macroLightTheme: Theme = {
  name: 'Macro Light',
  type: 'light',
  colors: {
    background: '#ffffff',
    foreground: '#09090b',
    card: '#ffffff',
    cardForeground: '#09090b',
    popover: '#ffffff',
    popoverForeground: '#09090b',
    primary: '#4f46e5',
    primaryForeground: '#fafafa',
    secondary: '#f4f4f5',
    secondaryForeground: '#18181b',
    muted: '#f4f4f5',
    mutedForeground: '#71717a',
    accent: '#f4f4f5',
    accentForeground: '#18181b',
    destructive: '#ef4444',
    destructiveForeground: '#fafafa',
    border: '#e4e4e7',
    input: '#e4e4e7',
    ring: '#4f46e5',
  },
};

describe('terminalTheme', () => {
  it('maps Macro dark to xterm surface colors', () => {
    const theme = buildTerminalTheme(macroDarkTheme);

    expect(theme.background).toBe('#09090b');
    expect(theme.foreground).toBe('#fafafa');
    expect(theme.cursor).toBe('#6366f1');
    expect(theme.selectionBackground).toBe('rgba(99, 102, 241, 0.280)');
  });

  it('maps Macro light to xterm surface colors', () => {
    const theme = buildTerminalTheme(macroLightTheme);

    expect(theme.background).toBe('#ffffff');
    expect(theme.foreground).toBe('#09090b');
    expect(theme.cursor).toBe('#4f46e5');
    expect(theme.selectionBackground).toBe('rgba(79, 70, 229, 0.200)');
  });

  it('provides readable ANSI colors for required xterm slots', () => {
    const theme = buildTerminalTheme(macroDarkTheme);

    for (const key of [
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'brightBlack',
      'brightRed',
      'brightGreen',
      'brightYellow',
      'brightBlue',
      'brightMagenta',
      'brightCyan',
      'brightWhite',
    ] as const) {
      expect(theme[key]).toBeTruthy();
    }
  });
});
