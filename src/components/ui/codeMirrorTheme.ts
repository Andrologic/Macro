import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { StyleModule } from 'style-mod';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import type { Theme } from '../../types/theme';
import { defaultTheme } from '../theme/ThemeProvider';

interface CodeMirrorBaseThemeOptions {
  hideVerticalScrollbar?: boolean;
}

interface CodeMirrorThemeTokens {
  isDark: boolean;
  editorBackground: string;
  editorForeground: string;
  gutterBackground: string;
  gutterForeground: string;
  gutterActiveForeground: string;
  border: string;
  lineNumberBorder: string;
  selectionBackground: string;
  activeLineBackground: string;
  cursor: string;
  focusRing: string;
  scrollbarThumb: string;
  addedLineBackground: string;
  addedLineAccent: string;
  removedLineBackground: string;
  removedLineAccent: string;
  addedInlineBackground: string;
  addedInlineForeground: string;
  removedInlineBackground: string;
  removedInlineForeground: string;
  diffPanelSeparator: string;
  revertRailBorder: string;
  revertButtonBackground: string;
  revertButtonHoverBackground: string;
  revertButtonForeground: string;
}

export interface CodeMirrorThemeMetadata {
  isDark: boolean;
  surfaceVars: Record<string, string>;
  diffVars: Record<string, string>;
}

const DEFAULT_INSERTED_ACCENT = {
  dark: '#2ea043',
  light: '#1a7f37',
};

const DEFAULT_DELETED_ACCENT = {
  dark: '#f85149',
  light: '#cf222e',
};

const clampChannel = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

const normalizeHex = (hex: string): string => {
  const sanitized = hex.trim().replace('#', '');
  if (sanitized.length === 3) {
    return `#${sanitized
      .split('')
      .map((char) => `${char}${char}`)
      .join('')}`.toLowerCase();
  }

  return `#${sanitized.slice(0, 6)}`.toLowerCase();
};

const hexToRgb = (hex: string) => {
  const normalized = normalizeHex(hex).slice(1);
  return {
    red: parseInt(normalized.slice(0, 2), 16),
    green: parseInt(normalized.slice(2, 4), 16),
    blue: parseInt(normalized.slice(4, 6), 16),
  };
};

const rgbToHex = ({
  red,
  green,
  blue,
}: {
  red: number;
  green: number;
  blue: number;
}) => `#${clampChannel(red).toString(16).padStart(2, '0')}${clampChannel(green).toString(16).padStart(2, '0')}${clampChannel(blue).toString(16).padStart(2, '0')}`;

const withAlpha = (hex: string, alpha: number): string => {
  const { red, green, blue } = hexToRgb(hex);
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
};

const mixHex = (sourceHex: string, targetHex: string, weight: number): string => {
  const source = hexToRgb(sourceHex);
  const target = hexToRgb(targetHex);
  const clampedWeight = Math.max(0, Math.min(1, weight));

  return rgbToHex({
    red: source.red + (target.red - source.red) * clampedWeight,
    green: source.green + (target.green - source.green) * clampedWeight,
    blue: source.blue + (target.blue - source.blue) * clampedWeight,
  });
};

const resolveTheme = (theme?: Theme): Theme => theme ?? defaultTheme;

const createTokens = (theme?: Theme): CodeMirrorThemeTokens => {
  const resolvedTheme = resolveTheme(theme);
  const { colors } = resolvedTheme;
  const isDark = resolvedTheme.type === 'dark';

  const editorBackground = normalizeHex(colors.card || colors.background);
  const editorForeground = normalizeHex(colors.cardForeground || colors.foreground);
  const gutterBackground = normalizeHex(colors.muted || colors.background);
  const gutterForeground = normalizeHex(colors.mutedForeground || colors.foreground);
  const gutterActiveForeground = normalizeHex(colors.foreground);
  const border = withAlpha(colors.border, isDark ? 0.9 : 0.8);
  const lineNumberBorder = withAlpha(colors.border, isDark ? 0.5 : 0.38);
  const selectionBackground = withAlpha(colors.primary, isDark ? 0.32 : 0.18);
  const activeLineBackground = withAlpha(colors.accent, isDark ? 0.42 : 0.72);
  const cursor = normalizeHex(colors.ring || colors.primary);
  const focusRing = withAlpha(colors.ring || colors.primary, isDark ? 0.46 : 0.3);
  const scrollbarThumbBase = mixHex(colors.foreground, colors.background, isDark ? 0.62 : 0.54);
  const insertedAccent = isDark ? DEFAULT_INSERTED_ACCENT.dark : DEFAULT_INSERTED_ACCENT.light;
  const deletedAccent = isDark ? DEFAULT_DELETED_ACCENT.dark : DEFAULT_DELETED_ACCENT.light;

  return {
    isDark,
    editorBackground,
    editorForeground,
    gutterBackground,
    gutterForeground,
    gutterActiveForeground,
    border,
    lineNumberBorder,
    selectionBackground,
    activeLineBackground,
    cursor,
    focusRing,
    scrollbarThumb: withAlpha(scrollbarThumbBase, isDark ? 0.46 : 0.28),
    addedLineBackground: withAlpha(insertedAccent, isDark ? 0.22 : 0.12),
    addedLineAccent: insertedAccent,
    removedLineBackground: withAlpha(deletedAccent, isDark ? 0.2 : 0.11),
    removedLineAccent: deletedAccent,
    addedInlineBackground: withAlpha(insertedAccent, isDark ? 0.34 : 0.18),
    addedInlineForeground: isDark ? '#c8f2d1' : '#1f5e32',
    removedInlineBackground: withAlpha(deletedAccent, isDark ? 0.34 : 0.18),
    removedInlineForeground: isDark ? '#ffd7d5' : '#8c2f39',
    diffPanelSeparator: withAlpha(colors.border, isDark ? 0.5 : 0.8),
    revertRailBorder: withAlpha(colors.border, isDark ? 0.36 : 0.52),
    revertButtonBackground: withAlpha(mixHex(colors.card, colors.background, isDark ? 0.18 : 0.08), isDark ? 0.96 : 0.98),
    revertButtonHoverBackground: withAlpha(mixHex(colors.accent, colors.background, isDark ? 0.22 : 0.04), isDark ? 0.98 : 1),
    revertButtonForeground: editorForeground,
  };
};

export const getCodeMirrorThemeMetadata = (theme?: Theme): CodeMirrorThemeMetadata => {
  const tokens = createTokens(theme);

  return {
    isDark: tokens.isDark,
    surfaceVars: {
      '--macro-cm-editor-background': tokens.editorBackground,
      '--macro-cm-editor-foreground': tokens.editorForeground,
      '--macro-cm-gutter-background': tokens.gutterBackground,
      '--macro-cm-selection-background': tokens.selectionBackground,
    },
    diffVars: {
      '--macro-cm-revert-button-background': tokens.revertButtonBackground,
      '--macro-cm-revert-button-hover-background': tokens.revertButtonHoverBackground,
    },
  };
};

export const getCodeMirrorSyntaxExtensions = (theme?: Theme): Extension[] => {
  return resolveTheme(theme).type === 'dark'
    ? [syntaxHighlighting(oneDarkHighlightStyle)]
    : [syntaxHighlighting(defaultHighlightStyle)];
};

export const createCodeMirrorBaseTheme = (
  theme?: Theme,
  options: CodeMirrorBaseThemeOptions = {}
) => {
  const tokens = createTokens(theme);
  const { hideVerticalScrollbar = false } = options;
  const contentPaddingTop = '8px';
  const contentPaddingRight = '0px';
  const contentPaddingBottom = '12px';
  const contentPaddingLeft = '0';
  const guttersPaddingTop = '0px';

  return EditorView.theme({
    '&': {
      fontSize: '13px',
      height: '100%',
      '--macro-diff-line-height': '24px',
      '--macro-cm-editor-background': tokens.editorBackground,
      '--macro-cm-editor-foreground': tokens.editorForeground,
      '--macro-cm-gutter-background': tokens.gutterBackground,
      '--macro-cm-selection-background': tokens.selectionBackground,
      color: tokens.editorForeground,
      backgroundColor: tokens.editorBackground,
    },
    '&.cm-focused': {
      outline: 'none',
      boxShadow: `inset 0 0 0 1px ${tokens.focusRing}`,
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      backgroundColor: tokens.editorBackground,
      ...(hideVerticalScrollbar
        ? {
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }
        : {}),
    },
    '.cm-scroller::-webkit-scrollbar': hideVerticalScrollbar
      ? {
          width: '0px',
          height: '10px',
        }
      : {
          width: '10px',
          height: '10px',
        },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      backgroundColor: tokens.scrollbarThumb,
      borderRadius: '999px',
    },
    '.cm-scroller::-webkit-scrollbar-track': {
      backgroundColor: 'transparent',
    },
    '.cm-scroller::-webkit-scrollbar-corner': {
      backgroundColor: 'transparent',
    },
    '.cm-scroller::-webkit-scrollbar:vertical': hideVerticalScrollbar
      ? {
          width: '0px',
        }
      : {},
    '.cm-content': {
      minHeight: '100%',
      padding: `${contentPaddingTop} ${contentPaddingRight} ${contentPaddingBottom} ${contentPaddingLeft}`,
      caretColor: tokens.cursor,
    },
    '.cm-gutters': {
      minHeight: '100%',
      paddingTop: guttersPaddingTop,
      paddingBottom: contentPaddingBottom,
      backgroundColor: tokens.gutterBackground,
      color: tokens.gutterForeground,
      borderRight: `1px solid ${tokens.lineNumberBorder}`,
    },
    '.cm-gutters.cm-gutters-before': {
      backgroundColor: tokens.editorBackground,
    },
    '.cm-gutters.cm-gutters-after': {
      backgroundColor: tokens.editorBackground,
    },
    '.cm-lineNumbers': {
      backgroundColor: tokens.editorBackground,
    },
    '.cm-lineNumbers.cm-gutter': {
      backgroundColor: tokens.editorBackground,
    },
    '.cm-gutter': {
      backgroundColor: tokens.editorBackground,
    },
    '.cm-gutterElement': {
      color: tokens.gutterForeground,
      backgroundColor: tokens.editorBackground,
    },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '3ch',
      paddingLeft: '8px',
      paddingRight: '8px',
    },
    '.cm-activeLine': {
      backgroundColor: tokens.activeLineBackground,
    },
    '.cm-activeLineGutter': {
      backgroundColor: tokens.activeLineBackground,
      color: tokens.gutterActiveForeground,
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: tokens.cursor,
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: tokens.selectionBackground,
    },
    '.cm-panels': {
      backgroundColor: tokens.editorBackground,
      color: tokens.editorForeground,
      borderColor: tokens.border,
    },
    '.cm-searchMatch': {
      backgroundColor: withAlpha(tokens.cursor, tokens.isDark ? 0.22 : 0.16),
      outline: `1px solid ${withAlpha(tokens.cursor, tokens.isDark ? 0.32 : 0.24)}`,
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: withAlpha(tokens.cursor, tokens.isDark ? 0.34 : 0.26),
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: withAlpha(tokens.cursor, tokens.isDark ? 0.18 : 0.12),
      outline: `1px solid ${withAlpha(tokens.cursor, tokens.isDark ? 0.3 : 0.22)}`,
    },
    '.cm-line.cm-git-added, .cm-line.cm-diff-added, .cm-line.cm-diff-modified-right': {
      backgroundColor: tokens.addedLineBackground,
      boxShadow: `inset 3px 0 0 ${tokens.addedLineAccent}`,
    },
    '.cm-line.cm-git-removed, .cm-line.cm-diff-removed, .cm-line.cm-diff-modified-left': {
      backgroundColor: tokens.removedLineBackground,
      boxShadow: `inset 3px 0 0 ${tokens.removedLineAccent}`,
    },
  }, { dark: tokens.isDark });
};

export const createCodeMirrorDiffTheme = (theme?: Theme) => {
  const tokens = createTokens(theme);
  const revertButtonWidth = '1.4rem';
  const revertButtonHeight = '1.9rem';
  const revertRailWidth = revertButtonWidth;
  const revertButtonVerticalTranslate = 'calc(-60% + (var(--macro-diff-line-height) / 2))';

  return EditorView.styleModule.of(new StyleModule({
    '.macro-diff-merge-root': {
      height: '100%',
      '--macro-cm-revert-button-background': tokens.revertButtonBackground,
      '--macro-cm-revert-button-hover-background': tokens.revertButtonHoverBackground,
    },
    '.macro-diff-merge-root .cm-editor.cm-focused': {
      outline: 'none',
      boxShadow: 'none',
    },
    '.macro-diff-merge-root .cm-mergeViewEditors': {
      display: 'flex',
      alignItems: 'stretch',
      minHeight: '100%',
    },
    '.macro-diff-merge-root .cm-mergeViewEditor': {
      display: 'flex',
      flexGrow: '1',
      flexBasis: '0',
      minWidth: '0',
      overflow: 'hidden',
    },
    '.macro-diff-merge-root .cm-mergeViewEditor:first-child': {
      boxShadow: `inset -1px 0 0 ${tokens.diffPanelSeparator}`,
    },
    '.macro-diff-merge-root .cm-mergeViewEditor .cm-editor': {
      flex: '1 1 auto',
      minWidth: '0',
      height: '100%',
    },
    '.macro-diff-merge-root .cm-merge-revert': {
      position: 'relative',
      width: revertRailWidth,
      minWidth: revertRailWidth,
      maxWidth: revertRailWidth,
      flexBasis: revertRailWidth,
      flexShrink: '0',
      overflow: 'visible',
      pointerEvents: 'none',
      backgroundColor: 'var(--macro-cm-editor-background, #ffffff)',
      zIndex: '30',
    },
    '.macro-diff-merge-root .cm-merge-revert button': {
      position: 'absolute',
      left: '0',
      width: revertButtonWidth,
      height: revertButtonHeight,
      minWidth: revertButtonWidth,
      maxWidth: revertButtonWidth,
      transform: `translateY(${revertButtonVerticalTranslate})`,
      transformOrigin: 'center',
      zIndex: '60',
      border: `1px solid ${tokens.revertRailBorder}`,
      borderRadius: '6px',
      backgroundColor: tokens.revertButtonBackground,
      color: tokens.revertButtonForeground,
      boxShadow: tokens.isDark
        ? '0 10px 24px rgba(15, 23, 42, 0.38)'
        : '0 10px 22px rgba(15, 23, 42, 0.14)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxSizing: 'border-box',
      cursor: 'pointer',
      pointerEvents: 'auto',
      lineHeight: '1',
      padding: '0',
      opacity: '0.94',
      transition: 'background-color 120ms ease, opacity 120ms ease, transform 120ms ease, box-shadow 120ms ease',
    },
    '.macro-diff-merge-root .cm-merge-revert button:hover': {
      opacity: '1',
      backgroundColor: tokens.revertButtonHoverBackground,
      transform: `translateY(${revertButtonVerticalTranslate}) scale(1.05)`,
      boxShadow: tokens.isDark
        ? '0 14px 28px rgba(15, 23, 42, 0.48)'
        : '0 14px 28px rgba(15, 23, 42, 0.18)',
    },
    '.macro-diff-merge-root .cm-merge-revert button:focus-visible': {
      outline: `2px solid ${tokens.cursor}`,
      outlineOffset: '1px',
    },
    '.macro-diff-merge-root .cm-merge-revert button:active': {
      transform: `translateY(${revertButtonVerticalTranslate}) scale(0.98)`,
    },
    '.macro-diff-merge-root .cm-merge-revert .macro-diff-revert-icon': {
      width: '0.78rem',
      height: '0.78rem',
      opacity: '1',
    },
    '.macro-diff-merge-root .cm-merge-a .cm-changedLine': {
      backgroundColor: tokens.removedLineBackground,
    },
    '.macro-diff-merge-root .cm-merge-b .cm-changedLine': {
      backgroundColor: tokens.addedLineBackground,
    },
    '.macro-diff-merge-root .cm-inlineChangedLine': {
      backgroundColor: tokens.addedLineBackground,
    },
    '.macro-diff-merge-root .cm-merge-a .cm-changedText': {
      backgroundColor: tokens.removedInlineBackground,
      color: tokens.removedInlineForeground,
      borderRadius: '2px',
    },
    '.macro-diff-merge-root .cm-merge-b .cm-changedText': {
      backgroundColor: tokens.addedInlineBackground,
      color: tokens.addedInlineForeground,
      borderRadius: '2px',
    },
    '.macro-diff-merge-root .cm-merge-a .cm-changedLineGutter': {
      backgroundColor: tokens.removedLineAccent,
    },
    '.macro-diff-merge-root .cm-merge-b .cm-changedLineGutter': {
      backgroundColor: tokens.addedLineAccent,
    },
    '.macro-diff-merge-root .cm-inlineChangedLineGutter': {
      backgroundColor: tokens.addedLineAccent,
    },
    '.macro-diff-merge-root .cm-deletedChunk': {
      paddingLeft: '6px',
      backgroundColor: tokens.removedLineBackground,
      borderRadius: '0 6px 6px 0',
    },
    '.macro-diff-merge-root .cm-deletedChunk .cm-deletedText': {
      backgroundColor: tokens.removedInlineBackground,
      color: tokens.removedInlineForeground,
      borderRadius: '2px',
    },
    '.macro-diff-merge-root .cm-deletedLineGutter': {
      backgroundColor: tokens.removedLineAccent,
    },
    '.macro-diff-merge-root .cm-deletedLine': {
      textDecoration: 'none',
    },
    '.macro-diff-merge-root .cm-deletedLine del': {
      textDecoration: 'none',
    },
    '.macro-diff-merge-root .cm-insertedLine': {
      textDecoration: 'none',
    },
    '.macro-diff-merge-root .cm-collapsedLines': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      margin: '6px 0',
      padding: '4px 10px',
      borderRadius: '999px',
      border: `1px solid ${tokens.revertRailBorder}`,
      backgroundColor: withAlpha(tokens.gutterBackground, tokens.isDark ? 0.84 : 0.94),
      color: tokens.gutterForeground,
      cursor: 'pointer',
      fontSize: '11px',
      fontWeight: '600',
      lineHeight: '1.2',
      boxShadow: tokens.isDark
        ? '0 8px 18px rgba(15, 23, 42, 0.24)'
        : '0 6px 14px rgba(15, 23, 42, 0.08)',
      transition: 'background-color 120ms ease, color 120ms ease, border-color 120ms ease',
    },
    '.macro-diff-merge-root .cm-collapsedLines:hover': {
      backgroundColor: withAlpha(tokens.selectionBackground, tokens.isDark ? 0.82 : 0.98),
      color: tokens.editorForeground,
      borderColor: withAlpha(tokens.cursor, tokens.isDark ? 0.48 : 0.3),
    },
  }));
};
