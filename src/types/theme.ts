export interface ThemeColors {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

export interface Theme {
  name: string;
  type: 'light' | 'dark';
  colors: ThemeColors;
}

export interface ThemeManifestItem {
  id: string;
  name: string;
  path: string;
  type: 'light' | 'dark';
}

export interface ThemeManifest {
  themes: ThemeManifestItem[];
}
