import { useRef, useEffect, useImperativeHandle, forwardRef, type CSSProperties } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { cn } from '../../utils/cn';
import { useOptionalTheme } from '../theme/ThemeProvider';
import {
  createCodeMirrorBaseTheme,
  createCodeMirrorDiffTheme,
  getCodeMirrorThemeMetadata,
  getCodeMirrorSyntaxExtensions,
} from './codeMirrorTheme';

export interface DiffMergeViewProps {
  original: string;
  modified: string;
  language?: string;
  className?: string;
  presentationMode?: 'focused' | 'full';
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

const createRevertIcon = () => {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('macro-diff-revert-icon');

  const arrowHead = document.createElementNS(svgNS, 'path');
  arrowHead.setAttribute('d', 'M9 14 4 9l5-5');
  arrowHead.setAttribute('fill', 'none');
  arrowHead.setAttribute('stroke', 'currentColor');
  arrowHead.setAttribute('stroke-width', '2');
  arrowHead.setAttribute('stroke-linecap', 'round');
  arrowHead.setAttribute('stroke-linejoin', 'round');

  const arrowBody = document.createElementNS(svgNS, 'path');
  arrowBody.setAttribute('d', 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5A5.5 5.5 0 0 1 14.5 20H11');
  arrowBody.setAttribute('fill', 'none');
  arrowBody.setAttribute('stroke', 'currentColor');
  arrowBody.setAttribute('stroke-width', '2');
  arrowBody.setAttribute('stroke-linecap', 'round');
  arrowBody.setAttribute('stroke-linejoin', 'round');

  svg.appendChild(arrowHead);
  svg.appendChild(arrowBody);

  return svg;
};

const createRevertControl = () => {
  const button = document.createElement('button');
  const label = 'Revert this chunk';

  button.type = 'button';
  button.className = 'macro-diff-revert-button';
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.appendChild(createRevertIcon());

  return button;
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
  presentationMode = 'focused',
  editable = true,
  autoFocus = false,
  onChange,
  onEditorReady,
  revertControls,
}, ref) => {
  const themeContext = useOptionalTheme();
  const themeMetadata = getCodeMirrorThemeMetadata(themeContext?.theme);
  const resolvedLanguage = resolveLanguageName(language);
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);
  const originalRef = useRef(original);
  const modifiedRef = useRef(modified);
  const onChangeRef = useRef(onChange);
  const onEditorReadyRef = useRef(onEditorReady);
  const syncingRef = useRef<'a' | 'b' | null>(null);
  const isApplyingExternalUpdateRef = useRef(false);
  const collapseUnchanged =
    presentationMode === 'focused'
      ? { margin: 3, minSize: 4 }
      : undefined;

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
    const baseTheme = createCodeMirrorBaseTheme(themeContext?.theme);
    const diffTheme = createCodeMirrorDiffTheme(themeContext?.theme);
    const themeExtensions = getCodeMirrorSyntaxExtensions(themeContext?.theme);

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
      renderRevertControl: () => createRevertControl(),
      highlightChanges: true,
      gutter: true,
      collapseUnchanged,
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
  }, [editable, resolvedLanguage, revertControls, themeContext?.theme]);

  useEffect(() => {
    const mergeView = mergeViewRef.current;
    if (!mergeView) {
      return;
    }

    mergeView.reconfigure({
      revertControls,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged,
    });
  }, [collapseUnchanged, revertControls]);

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
      style={{
        ...themeMetadata.surfaceVars,
        ...themeMetadata.diffVars,
      } as CSSProperties}
      className={cn(
        'h-full overflow-hidden rounded-md border border-border',
        className
      )}
    />
  );
});

DiffMergeView.displayName = 'DiffMergeView';

export default DiffMergeView;
