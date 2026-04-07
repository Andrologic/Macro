import { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { StyleModule } from 'style-mod';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { oneDark } from '@codemirror/theme-one-dark';
import { cn } from '../../utils/cn';
import { useOptionalTheme } from '../theme/ThemeProvider';

export interface DiffMergeViewProps {
  original: string;
  modified: string;
  language?: string;
  className?: string;
  editable?: boolean;
  autoFocus?: boolean;
  onChange?: (value: string) => void;
  onEditorReady?: (editor: MergeViewEditorHandle | null) => void;
  revertControls?: 'a-to-b' | 'b-to-a';
}

export interface MergeViewEditorHandle {
  a: EditorView;
  b: EditorView;
  dom: HTMLElement;
}

const resolveLanguageName = (language: string) => {
  if (language === 'rust') {
    return 'rust';
  }
  if (language === 'javascript' || language === 'jsx') {
    return 'javascript';
  }
  if (language === 'typescript' || language === 'tsx') {
    return 'typescript';
  }
  return 'text';
};

const resolveLanguageExtension = (language: string) => {
  if (language === 'rust') {
    return rust();
  }
  if (language === 'javascript') {
    return javascript({ jsx: true, typescript: false });
  }
  if (language === 'typescript') {
    return javascript({ jsx: true, typescript: true });
  }
  return [];
};

const createRevertIcon = (direction: 'left' | 'right') => {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('macro-diff-revert-icon');

  const line = document.createElementNS(svgNS, 'path');
  const head = document.createElementNS(svgNS, 'path');

  if (direction === 'left') {
    line.setAttribute('d', 'M15 10H5');
    head.setAttribute('d', 'M9 6l-4 4 4 4');
  } else {
    line.setAttribute('d', 'M5 10h10');
    head.setAttribute('d', 'M11 6l4 4-4 4');
  }

  for (const element of [line, head]) {
    element.setAttribute('fill', 'none');
    element.setAttribute('stroke', 'currentColor');
    element.setAttribute('stroke-width', '2.2');
    element.setAttribute('stroke-linecap', 'round');
    element.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(element);
  }

  return svg;
};

const createRevertControl = (direction: 'left' | 'right') => {
  const button = document.createElement('button');
  const label = 'Revert this chunk';

  button.type = 'button';
  button.className = 'macro-diff-revert-button';
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.appendChild(createRevertIcon(direction));

  return button;
};

const createEditorTheme = (isDark: boolean) => EditorView.theme({
  '&': {
    fontSize: '13px',
    height: '100%',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '3ch',
    paddingLeft: '8px',
    paddingRight: '8px',
  },
}, { dark: isDark });

const createDiffTheme = (isDark: boolean) => {
  const deletedLineBackground = isDark ? 'rgba(248, 81, 73, 0.24)' : 'rgba(248, 81, 73, 0.16)';
  const deletedAccent = isDark ? 'rgb(248, 81, 73)' : 'rgb(207, 34, 46)';
  const deletedTextBackground = isDark ? 'rgba(248, 81, 73, 0.38)' : 'rgba(248, 81, 73, 0.24)';
  const deletedTextColor = isDark ? '#ffd7d5' : '#8c2f39';
  const insertedLineBackground = isDark ? 'rgba(46, 160, 67, 0.24)' : 'rgba(46, 160, 67, 0.16)';
  const insertedAccent = isDark ? 'rgb(46, 160, 67)' : 'rgb(26, 127, 55)';
  const insertedTextBackground = isDark ? 'rgba(46, 160, 67, 0.38)' : 'rgba(46, 160, 67, 0.24)';
  const insertedTextColor = isDark ? '#c8f2d1' : '#1f5e32';
  const panelSeparator = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(15, 23, 42, 0.12)';
  const revertRailBorder = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.08)';
  const revertButtonBackground = isDark ? 'rgba(39, 44, 52, 0.9)' : 'rgba(255, 255, 255, 0.95)';
  const revertButtonHoverBackground = isDark ? 'rgba(63, 70, 82, 0.98)' : 'rgba(241, 245, 249, 0.98)';
  const revertButtonColor = isDark ? '#f8fafc' : '#0f172a';

  return EditorView.styleModule.of(new StyleModule({
    '.macro-diff-merge-root': {
      height: '100%',
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
      boxShadow: `inset -1px 0 0 ${panelSeparator}`,
    },
    '.macro-diff-merge-root .cm-mergeViewEditor .cm-editor': {
      flex: '1 1 auto',
      minWidth: '0',
      height: '100%',
    },
    '.macro-diff-merge-root .cm-merge-revert': {
      position: 'relative',
      width: '0',
      minWidth: '0',
      maxWidth: '0',
      flexBasis: '0',
      flexShrink: '0',
      overflow: 'visible',
      marginLeft: '-1rem',
      marginRight: '-1rem',
      pointerEvents: 'none',
      zIndex: '30',
    },
    '.macro-diff-merge-root .cm-merge-revert button': {
      position: 'absolute',
      left: '0',
      width: '2rem',
      height: '2rem',
      minWidth: '2rem',
      maxWidth: '2rem',
      transform: 'translateX(-50%)',
      transformOrigin: 'center',
      zIndex: '60',
      border: `1px solid ${revertRailBorder}`,
      borderRadius: '999px',
      backgroundColor: revertButtonBackground,
      color: revertButtonColor,
      boxShadow: isDark
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
      backgroundColor: revertButtonHoverBackground,
      transform: 'translateX(-50%) scale(1.05)',
      boxShadow: isDark
        ? '0 14px 28px rgba(15, 23, 42, 0.48)'
        : '0 14px 28px rgba(15, 23, 42, 0.18)',
    },
    '.macro-diff-merge-root .cm-merge-revert button:focus-visible': {
      outline: `2px solid ${insertedAccent}`,
      outlineOffset: '1px',
    },
    '.macro-diff-merge-root .cm-merge-revert button:active': {
      transform: 'translateX(-50%) scale(0.98)',
    },
    '.macro-diff-merge-root .cm-merge-revert .macro-diff-revert-icon': {
      width: '1rem',
      height: '1rem',
      opacity: '1',
    },
    '.macro-diff-merge-root .cm-merge-a .cm-changedLine': {
      backgroundColor: deletedLineBackground,
    },
    '.macro-diff-merge-root .cm-merge-b .cm-changedLine': {
      backgroundColor: insertedLineBackground,
    },
    '.macro-diff-merge-root .cm-inlineChangedLine': {
      backgroundColor: insertedLineBackground,
    },
    '.macro-diff-merge-root .cm-merge-a .cm-changedText': {
      backgroundColor: deletedTextBackground,
      color: deletedTextColor,
      borderRadius: '2px',
    },
    '.macro-diff-merge-root .cm-merge-b .cm-changedText': {
      backgroundColor: insertedTextBackground,
      color: insertedTextColor,
      borderRadius: '2px',
    },
    '.macro-diff-merge-root .cm-merge-a .cm-changedLineGutter': {
      backgroundColor: deletedAccent,
    },
    '.macro-diff-merge-root .cm-merge-b .cm-changedLineGutter': {
      backgroundColor: insertedAccent,
    },
    '.macro-diff-merge-root .cm-inlineChangedLineGutter': {
      backgroundColor: insertedAccent,
    },
    '.macro-diff-merge-root .cm-deletedChunk': {
      paddingLeft: '6px',
      backgroundColor: deletedLineBackground,
      borderRadius: '0 6px 6px 0',
    },
    '.macro-diff-merge-root .cm-deletedChunk .cm-deletedText': {
      backgroundColor: deletedTextBackground,
      color: deletedTextColor,
      borderRadius: '2px',
    },
    '.macro-diff-merge-root .cm-deletedLineGutter': {
      backgroundColor: deletedAccent,
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
  }));
};

/**
 * Scrolls the MergeView to the first changed line after the diff has been computed.
 * Uses a small delay to let CodeMirror finish its diff computation before looking
 * for highlighted elements.
 */
const scrollToFirstChange = (mergeView: MergeView) => {
  requestAnimationFrame(() => {
    const firstChanged = mergeView.dom.querySelector('.cm-changedLine, .cm-deletedChunk');
    if (firstChanged) {
      // Save scrollLeft for all scrollers to prevent horizontal scrolling
      const scrollers = Array.from(mergeView.dom.querySelectorAll('.cm-scroller'));
      const scrollLefts = scrollers.map(s => s.scrollLeft);
      
      firstChanged.scrollIntoView({ block: 'center', inline: 'nearest' });
      
      // Restore scrollLeft
      requestAnimationFrame(() => {
        scrollers.forEach((s, i) => {
          s.scrollLeft = scrollLefts[i] ?? 0;
        });
      });
    }
  });
};

export const DiffMergeView = forwardRef<MergeViewEditorHandle, DiffMergeViewProps>(({
  original,
  modified,
  language = 'typescript',
  className,
  editable = true,
  autoFocus = false,
  onChange,
  onEditorReady,
  revertControls,
}, ref) => {
  const themeContext = useOptionalTheme();
  const isDark = themeContext?.isDark ?? true;
  const resolvedLanguage = resolveLanguageName(language);
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);
  const originalRef = useRef(original);
  const modifiedRef = useRef(modified);
  const onChangeRef = useRef(onChange);
  const onEditorReadyRef = useRef(onEditorReady);
  const syncingRef = useRef<'a' | 'b' | null>(null);
  const isApplyingExternalUpdateRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onEditorReadyRef.current = onEditorReady;
  }, [onEditorReady]);

  useEffect(() => {
    originalRef.current = original;
    modifiedRef.current = modified;
  }, [modified, original]);

  useEffect(() => {
    if (!containerRef.current) return;

    const languageExt = resolveLanguageExtension(resolvedLanguage);
    const baseTheme = createEditorTheme(isDark);
    const diffTheme = createDiffTheme(isDark);
    const themeExtensions = isDark ? [oneDark] : [];

    const mergeView = new MergeView({
      a: {
        doc: originalRef.current,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          ...themeExtensions,
          baseTheme,
          diffTheme,
          languageExt,
          EditorState.readOnly.of(true),
        ],
      },
      b: {
        doc: modifiedRef.current,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          ...themeExtensions,
          baseTheme,
          diffTheme,
          languageExt,
          EditorView.editable.of(editable),
          EditorState.readOnly.of(!editable),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || isApplyingExternalUpdateRef.current) return;
            onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      },
      parent: containerRef.current,
      revertControls,
      renderRevertControl: () => createRevertControl(revertControls === 'b-to-a' ? 'left' : 'right'),
      highlightChanges: true,
      gutter: true,
    });

    mergeView.dom.classList.add('macro-diff-merge-root');
    mergeViewRef.current = mergeView;

    const handle: MergeViewEditorHandle = {
      a: mergeView.a,
      b: mergeView.b,
      dom: mergeView.dom,
    };

    onEditorReadyRef.current?.(handle);

    // Auto-scroll to the first changed line
    scrollToFirstChange(mergeView);

    const aScroll = mergeView.a.scrollDOM;
    const bScroll = mergeView.b.scrollDOM;

    const syncScroll = (source: 'a' | 'b', target: EditorView['scrollDOM']) => {
      return () => {
        if (syncingRef.current && syncingRef.current !== source) return;
        syncingRef.current = source;

        const sourceEl = source === 'a' ? aScroll : bScroll;
        const scrollRatio = sourceEl.scrollTop / Math.max(1, sourceEl.scrollHeight - sourceEl.clientHeight);
        const targetScrollTop = scrollRatio * Math.max(1, target.scrollHeight - target.clientHeight);

        if (Math.abs(target.scrollTop - targetScrollTop) > 1) {
          target.scrollTop = targetScrollTop;
        }

        requestAnimationFrame(() => {
          if (syncingRef.current === source) {
            syncingRef.current = null;
          }
        });
      };
    };

    const aToB = syncScroll('a', bScroll);
    const bToA = syncScroll('b', aScroll);

    aScroll.addEventListener('scroll', aToB, { passive: true });
    bScroll.addEventListener('scroll', bToA, { passive: true });

    return () => {
      aScroll.removeEventListener('scroll', aToB);
      bScroll.removeEventListener('scroll', bToA);
      onEditorReadyRef.current?.(null);
      mergeView.destroy();
      mergeViewRef.current = null;
    };
  }, [editable, isDark, resolvedLanguage, revertControls]);

  useEffect(() => {
    if (!autoFocus || !editable) return;
    mergeViewRef.current?.b.focus();
  }, [autoFocus, editable]);

  useEffect(() => {
    const mergeView = mergeViewRef.current;
    if (!mergeView) return;

    const currentOriginal = mergeView.a.state.doc.toString();
    const currentModified = mergeView.b.state.doc.toString();
    const shouldUpdateOriginal = currentOriginal !== original;
    const shouldUpdateModified = currentModified !== modified;

    if (!shouldUpdateOriginal && !shouldUpdateModified) {
      return;
    }

    if (shouldUpdateOriginal) {
      mergeView.a.dispatch({
        changes: {
          from: 0,
          to: currentOriginal.length,
          insert: original,
        },
      });
    }

    if (!shouldUpdateModified) {
      return;
    }

    isApplyingExternalUpdateRef.current = true;
    try {
      mergeView.b.dispatch({
        changes: {
          from: 0,
          to: currentModified.length,
          insert: modified,
        },
      });
    } finally {
      isApplyingExternalUpdateRef.current = false;
    }
  }, [modified, original]);

  useImperativeHandle(ref, () => {
    return {
      get a() {
        const mergeView = mergeViewRef.current;
        if (!mergeView) {
          throw new Error('MergeView not initialized');
        }
        return mergeView.a;
      },
      get b() {
        const mergeView = mergeViewRef.current;
        if (!mergeView) {
          throw new Error('MergeView not initialized');
        }
        return mergeView.b;
      },
      get dom() {
        const mergeView = mergeViewRef.current;
        if (!mergeView) {
          throw new Error('MergeView not initialized');
        }
        return mergeView.dom;
      },
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-language={resolvedLanguage}
      className={cn(
        'h-full overflow-hidden rounded-md border border-border',
        className
      )}
    />
  );
});

DiffMergeView.displayName = 'DiffMergeView';

export default DiffMergeView;
