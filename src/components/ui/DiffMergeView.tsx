import { useRef, useEffect, useImperativeHandle, forwardRef, useMemo, type CSSProperties } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { useTranslation } from 'react-i18next';
import type { CodeOverflowMode } from '../../types';
import { cn } from '../../utils/cn';
import { useAppStore } from '../../stores/useAppStore';
import { useOptionalTheme } from '../theme/ThemeProvider';
import {
  createCodeMirrorBaseTheme,
  createCodeMirrorDiffTheme,
  getCodeMirrorThemeMetadata,
  getCodeMirrorSyntaxExtensions,
} from './codeMirrorTheme';
import {
  createCodeMirrorDiffHighlightExtension,
  codeMirrorDiffHighlightBaseTheme,
} from './codeMirrorDiffHighlights';
import { collectRevertButtonPositions } from './diffMergeRevertAlignment';
import { mapScrollOffsetByRatio } from './diffMergeScrollSync';

export interface DiffMergeViewProps {
  original: string;
  modified: string;
  language?: string;
  className?: string;
  layout?: 'split' | 'left-only' | 'right-only';
  presentationMode?: 'focused' | 'full';
  editable?: boolean;
  autoFocus?: boolean;
  onChange?: (value: string) => void;
  onEditorReady?: (editor: MergeViewEditorHandle | null) => void;
  revertControls?: 'a-to-b' | 'b-to-a';
  revertControlLabel?: string;
  overflowMode?: CodeOverflowMode;
  validatedRemovedLineNumbers?: number[];
  validatedAddedLineNumbers?: number[];
}

export interface MergeViewEditorHandle {
  a: EditorView;
  b: EditorView;
  dom: HTMLElement;
}

const CODEMIRROR_UNCHANGED_LINES_PHRASE = '$ unchanged lines';
const EMPTY_VALIDATED_LINE_NUMBERS: number[] = [];
const DEBUG_FILE_DIFF_STORAGE_KEY = 'debug:file-diff';

const isFileDiffDebugEnabled = (): boolean =>
  Boolean(import.meta.env?.DEV) &&
  typeof window !== 'undefined' &&
  window.localStorage.getItem(DEBUG_FILE_DIFF_STORAGE_KEY) === '1';

const debugDiffMergeViewLog = (event: string, details?: Record<string, unknown>): void => {
  if (!isFileDiffDebugEnabled()) {
    return;
  }

  console.debug(`[DiffMergeView] ${event}`, details ?? {});
};

const hasRevertRelevantLayoutChange = (
  update: Pick<Parameters<Parameters<typeof EditorView.updateListener.of>[0]>[0], 'docChanged' | 'heightChanged' | 'viewportChanged' | 'geometryChanged'>
) => update.docChanged || update.heightChanged || update.viewportChanged || update.geometryChanged;

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

const createRevertControl = (label: string) => {
  const button = document.createElement('button');

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
  layout = 'split',
  presentationMode = 'focused',
  editable = true,
  autoFocus = false,
  onChange,
  onEditorReady,
  revertControls,
  revertControlLabel,
  overflowMode,
  validatedRemovedLineNumbers = EMPTY_VALIDATED_LINE_NUMBERS,
  validatedAddedLineNumbers = EMPTY_VALIDATED_LINE_NUMBERS,
}, ref) => {
  const { t, i18n } = useTranslation();
  const globalOverflowMode = useAppStore((state) => state.codeOverflowMode);
  const themeContext = useOptionalTheme();
  const themeMetadata = getCodeMirrorThemeMetadata(themeContext?.theme);
  const resolvedLanguage = resolveLanguageName(language);
  const resolvedOverflowMode = overflowMode ?? globalOverflowMode;
  const resolvedLocale = i18n?.resolvedLanguage || i18n?.language || 'en';
  const unchangedLinesPhrase = t('diffMergeView.codeMirrorPhrases.unchangedLines', {
    defaultValue: CODEMIRROR_UNCHANGED_LINES_PHRASE,
  });
  const resolvedRevertControlLabel =
    revertControlLabel ?? t('diffMergeView.revertChunk', 'Revert this chunk');
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);
  const originalRef = useRef(original);
  const modifiedRef = useRef(modified);
  const onChangeRef = useRef(onChange);
  const onEditorReadyRef = useRef(onEditorReady);
  const scheduleRevertAlignmentRef = useRef<(() => void) | null>(null);
  const revertControlsRef = useRef(revertControls);
  const revertControlLabelRef = useRef(resolvedRevertControlLabel);
  const collapseUnchangedRef = useRef<{ margin: number; minSize: number } | undefined>(undefined);
  const syncingRef = useRef<'a' | 'b' | null>(null);
  const lastScrollTopRef = useRef({ a: 0, b: 0 });
  const isApplyingExternalUpdateRef = useRef(false);

  const collapseUnchanged = useMemo(
    () =>
      presentationMode === 'focused'
        ? { margin: 3, minSize: 4 }
        : undefined,
    [presentationMode]
  );
  const leftValidatedHighlights = useMemo(
    () => validatedRemovedLineNumbers.map((lineNumber) => ({
      lineNumber,
      lineClass: 'cm-diff-staged-removed',
      gutterClass: 'cm-diff-gutter-staged-removed',
    })),
    [validatedRemovedLineNumbers]
  );
  const rightValidatedHighlights = useMemo(
    () => validatedAddedLineNumbers.map((lineNumber) => ({
      lineNumber,
      lineClass: 'cm-diff-staged-added',
      gutterClass: 'cm-diff-gutter-staged-added',
    })),
    [validatedAddedLineNumbers]
  );

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onEditorReadyRef.current = onEditorReady;
  }, [onEditorReady]);

  useEffect(() => {
    revertControlsRef.current = revertControls;
  }, [revertControls]);

  useEffect(() => {
    revertControlLabelRef.current = resolvedRevertControlLabel;
    const currentMergeView = mergeViewRef.current;
    if (!currentMergeView) return;

    currentMergeView.dom
      .querySelectorAll<HTMLButtonElement>('.cm-merge-revert button')
      .forEach((button) => {
        button.setAttribute('aria-label', resolvedRevertControlLabel);
        button.setAttribute('title', resolvedRevertControlLabel);
      });
  }, [resolvedRevertControlLabel]);

  useEffect(() => {
    collapseUnchangedRef.current = collapseUnchanged;
  }, [collapseUnchanged]);

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
    const leftHighlightExtensions = createCodeMirrorDiffHighlightExtension(
      EditorState.create({ doc: originalRef.current }).doc,
      leftValidatedHighlights
    );
    const rightHighlightExtensions = createCodeMirrorDiffHighlightExtension(
      EditorState.create({ doc: modifiedRef.current }).doc,
      rightValidatedHighlights
    );
    const phrasesExtension = EditorState.phrases.of({
      [CODEMIRROR_UNCHANGED_LINES_PHRASE]: unchangedLinesPhrase,
    });
    const requestRevertAlignment = (
      update: Pick<Parameters<Parameters<typeof EditorView.updateListener.of>[0]>[0], 'docChanged' | 'heightChanged' | 'viewportChanged' | 'geometryChanged'>
    ) => {
      if (!revertControlsRef.current || !hasRevertRelevantLayoutChange(update)) {
        return;
      }

      scheduleRevertAlignmentRef.current?.();
    };

    const mergeView = new MergeView({
      a: {
        doc: originalRef.current,
        extensions: [
          basicSetup,
          ...(resolvedOverflowMode === 'wrap' ? [EditorView.lineWrapping] : []),
          ...themeExtensions,
          baseTheme,
          diffTheme,
          codeMirrorDiffHighlightBaseTheme,
          ...leftHighlightExtensions,
          languageExt,
          phrasesExtension,
          EditorView.updateListener.of((update) => {
            requestRevertAlignment(update);
          }),
          EditorState.readOnly.of(true),
        ],
      },
      b: {
        doc: modifiedRef.current,
        extensions: [
          basicSetup,
          ...(resolvedOverflowMode === 'wrap' ? [EditorView.lineWrapping] : []),
          ...themeExtensions,
          baseTheme,
          diffTheme,
          codeMirrorDiffHighlightBaseTheme,
          ...rightHighlightExtensions,
          languageExt,
          phrasesExtension,
          EditorView.editable.of(editable),
          EditorState.readOnly.of(!editable),
          EditorView.updateListener.of((update) => {
            requestRevertAlignment(update);
            if (!update.docChanged || isApplyingExternalUpdateRef.current) return;
            onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      },
      parent: containerRef.current,
      revertControls: revertControlsRef.current,
      renderRevertControl: () => createRevertControl(revertControlLabelRef.current),
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: collapseUnchangedRef.current,
    });

    mergeView.dom.classList.add('macro-diff-merge-root');
    mergeViewRef.current = mergeView;
    debugDiffMergeViewLog('mount', {
      language: resolvedLanguage,
      editable,
      originalLength: originalRef.current.length,
      modifiedLength: modifiedRef.current.length,
    });

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
    const ownerWindow = mergeView.dom.ownerDocument.defaultView ?? window;
    const ResizeObserverCtor = ownerWindow.ResizeObserver;
    let revertAlignmentFrame: number | null = null;
    lastScrollTopRef.current = {
      a: aScroll.scrollTop,
      b: bScroll.scrollTop,
    };

    const scheduleRevertAlignment = () => {
      const currentRevertControls = revertControlsRef.current;
      if (!currentRevertControls) {
        return;
      }
      if (revertAlignmentFrame != null) {
        return;
      }

      revertAlignmentFrame = ownerWindow.requestAnimationFrame(() => {
        revertAlignmentFrame = ownerWindow.requestAnimationFrame(() => {
          revertAlignmentFrame = null;
          const currentMergeView = mergeViewRef.current;
          if (!currentMergeView) {
            return;
          }

          const revertButtons = Array.from(
            currentMergeView.dom.querySelectorAll('.cm-merge-revert button')
          ) as HTMLElement[];
          const positions = collectRevertButtonPositions(
            currentMergeView,
            currentRevertControls,
            revertButtons
          );

          if (mergeViewRef.current !== currentMergeView) {
            return;
          }

          for (const { button, top } of positions) {
            const nextTop = `${top}px`;
            if (button.style.top !== nextTop) {
              button.style.top = nextTop;
            }
          }
        });
      });
    };

    scheduleRevertAlignmentRef.current = scheduleRevertAlignment;

    const syncScroll = (source: 'a' | 'b', target: EditorView['scrollDOM']) => {
      return () => {
        if (syncingRef.current && syncingRef.current !== source) return;
        syncingRef.current = source;

        const sourceEl = source === 'a' ? aScroll : bScroll;
        const targetKey = source === 'a' ? 'b' : 'a';
        const previousScrollTop = lastScrollTopRef.current[source];
        const targetScrollTop = mapScrollOffsetByRatio({
          sourceOffset: sourceEl.scrollTop,
          sourceScrollSize: sourceEl.scrollHeight,
          sourceClientSize: sourceEl.clientHeight,
          targetScrollSize: target.scrollHeight,
          targetClientSize: target.clientHeight,
        });
        const didVerticalScroll = Math.abs(sourceEl.scrollTop - previousScrollTop) > 1;

        if (Math.abs(target.scrollTop - targetScrollTop) > 1) {
          target.scrollTop = targetScrollTop;
        }

        if (resolvedOverflowMode === 'horizontal_scroll') {
          const targetScrollLeft = mapScrollOffsetByRatio({
            sourceOffset: sourceEl.scrollLeft,
            sourceScrollSize: sourceEl.scrollWidth,
            sourceClientSize: sourceEl.clientWidth,
            targetScrollSize: target.scrollWidth,
            targetClientSize: target.clientWidth,
          });

          if (Math.abs(target.scrollLeft - targetScrollLeft) > 1) {
            target.scrollLeft = targetScrollLeft;
          }
        }

        lastScrollTopRef.current[source] = sourceEl.scrollTop;
        lastScrollTopRef.current[targetKey] = target.scrollTop;

        if (didVerticalScroll) {
          scheduleRevertAlignment();
        }

        ownerWindow.requestAnimationFrame(() => {
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

    const resizeObserver = ResizeObserverCtor
      ? new ResizeObserverCtor(() => {
          scheduleRevertAlignment();
        })
      : null;

    resizeObserver?.observe(containerRef.current);
    ownerWindow.addEventListener('resize', scheduleRevertAlignment);
    scheduleRevertAlignment();

    return () => {
      scheduleRevertAlignmentRef.current = null;
      resizeObserver?.disconnect();
      ownerWindow.removeEventListener('resize', scheduleRevertAlignment);
      if (revertAlignmentFrame != null) {
        ownerWindow.cancelAnimationFrame(revertAlignmentFrame);
      }
      aScroll.removeEventListener('scroll', aToB);
      bScroll.removeEventListener('scroll', bToA);
      onEditorReadyRef.current?.(null);
      mergeView.destroy();
      mergeViewRef.current = null;
      debugDiffMergeViewLog('unmount', {
        language: resolvedLanguage,
      });
    };
  }, [
    editable,
    leftValidatedHighlights,
    resolvedLanguage,
    resolvedLocale,
    resolvedOverflowMode,
    rightValidatedHighlights,
    themeContext?.theme,
    unchangedLinesPhrase,
  ]);

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
    scheduleRevertAlignmentRef.current?.();
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
      scheduleRevertAlignmentRef.current?.();
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

    scheduleRevertAlignmentRef.current?.();
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
      data-diff-merge-view="true"
      data-layout={layout}
      data-language={resolvedLanguage}
      data-overflow-mode={resolvedOverflowMode}
      style={{
        ...themeMetadata.surfaceVars,
        ...themeMetadata.diffVars,
      } as CSSProperties}
      className={cn(
        'macro-diff-host',
        'h-full w-full min-w-0 overflow-hidden rounded-md border border-border',
        className
      )}
    />
  );
});

DiffMergeView.displayName = 'DiffMergeView';

export default DiffMergeView;
