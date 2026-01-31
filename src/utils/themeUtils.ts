import { Theme } from '../types/theme';

export function hexToRgb(hex: string): string {
  // Remove # if present
  hex = hex.replace('#', '');

  // Parse r, g, b
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  return `${r} ${g} ${b}`;
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  
  // Apply scheme class (light/dark)
  if (theme.type === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  // Helper to set CSS variable
  const setVar = (name: string, hex: string) => {
    root.style.setProperty(`--${name}`, hexToRgb(hex));
  };

  // Map theme colors to CSS variables
  setVar('background', theme.colors.background);
  setVar('foreground', theme.colors.foreground);
  setVar('card', theme.colors.card);
  setVar('card-foreground', theme.colors.cardForeground);
  setVar('popover', theme.colors.popover);
  setVar('popover-foreground', theme.colors.popoverForeground);
  setVar('primary', theme.colors.primary);
  setVar('primary-foreground', theme.colors.primaryForeground);
  setVar('secondary', theme.colors.secondary);
  setVar('secondary-foreground', theme.colors.secondaryForeground);
  setVar('muted', theme.colors.muted);
  setVar('muted-foreground', theme.colors.mutedForeground);
  setVar('accent', theme.colors.accent);
  setVar('accent-foreground', theme.colors.accentForeground);
  setVar('destructive', theme.colors.destructive);
  setVar('destructive-foreground', theme.colors.destructiveForeground);
  setVar('border', theme.colors.border);
  setVar('input', theme.colors.input);
  setVar('ring', theme.colors.ring);
}
