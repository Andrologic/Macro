import { describe, expect, it } from 'bun:test';
import { deriveTitlebarTheme } from './themeUtils';
import type { Theme } from '../types/theme';

const darkTheme: Theme = {
  name: 'Macro Dark',
  type: 'dark',
  colors: {
    background: '#09090b',
    foreground: '#fafafa',
    card: '#09090b',
    cardForeground: '#fafafa',
    popover: '#111117',
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

const lightTheme: Theme = {
  name: 'Macro Light',
  type: 'light',
  colors: {
    background: '#fafafc',
    foreground: '#18181b',
    card: '#ffffff',
    cardForeground: '#18181b',
    popover: '#ffffff',
    popoverForeground: '#18181b',
    primary: '#4f46e5',
    primaryForeground: '#ffffff',
    secondary: '#f4f4f5',
    secondaryForeground: '#18181b',
    muted: '#f4f4f5',
    mutedForeground: '#52525b',
    accent: '#eef2ff',
    accentForeground: '#18181b',
    destructive: '#dc2626',
    destructiveForeground: '#ffffff',
    border: '#e4e4e7',
    input: '#e4e4e7',
    ring: '#4f46e5',
  },
};

describe('deriveTitlebarTheme', () => {
  it('derives a dark title bar palette with a native background surface', () => {
    const tokens = deriveTitlebarTheme(darkTheme);

    expect(tokens.backgroundStart).toMatch(/^#[0-9a-f]{6}$/);
    expect(tokens.backgroundMid).toMatch(/^#[0-9a-f]{6}$/);
    expect(tokens.backgroundEnd).toMatch(/^#[0-9a-f]{6}$/);
    expect(tokens.backgroundStart).not.toBe(tokens.backgroundEnd);
    expect(tokens.nativeWindowBackground).toBe(tokens.backgroundMid);
  });

  it('derives a distinct light title bar palette from the same contract', () => {
    const darkTokens = deriveTitlebarTheme(darkTheme);
    const lightTokens = deriveTitlebarTheme(lightTheme);

    expect(lightTokens.backgroundStart).not.toBe(darkTokens.backgroundStart);
    expect(lightTokens.controlBackground).not.toBe(darkTokens.controlBackground);
    expect(lightTokens.nativeWindowBackground).toBe(lightTokens.backgroundMid);
  });
});
