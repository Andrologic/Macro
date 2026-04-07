import { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { oneDark } from '@codemirror/theme-one-dark';
import { cn } from '../../utils/cn';

export interface DiffMergeViewProps {
  original: string;
  modified: string;
  language?: string;
  className?: string;
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

const resolveLanguageExtension = (language: string) => {
  if (language === 'rust') {
    return rust();
  }
  if (language === 'javascript' || language === 'jsx') {
    return javascript({ jsx: true, typescript: false });
  }
  if (language === 'typescript' || language === 'tsx') {
    return javascript({ jsx: true, typescript: true });
  }
  return [];
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
  '.cm-content': {
    minHeight: '100%',
    padding: '12px 24px 16px 12px',
  },
  '.cm-gutters': {
    minHeight: '100%',
    paddingTop: '12px',
    paddingBottom: '16px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '3ch',
    paddingLeft: '8px',
    paddingRight: '8px',
  },
}, { dark: isDark });

const createDiffTheme = () => EditorView.baseTheme({
  '&dark .cm-changedLines': {
    backgroundColor: 'rgba(248, 81, 73, 0.1)',
    borderLeft: '3px solid rgba(248, 81, 73, 0.4)',
    borderRight: '3px solid rgba(46, 160, 67, 0.4)',
  },
  '&light .cm-changedLines': {
    backgroundColor: 'rgba(248, 81, 73, 0.06)',
    borderLeft: '3px solid rgba(207, 34, 46, 0.4)',
    borderRight: '3px solid rgba(26, 127, 55, 0.4)',
  },
  '&dark .cm-deletedChunk': {
    backgroundColor: 'rgba(248, 81, 73, 0.15)',
    borderLeft: '3px solid rgb(248, 81, 73)',
    borderRight: '3px solid rgb(248, 81, 73)',
  },
  '&light .cm-deletedChunk': {
    backgroundColor: 'rgba(248, 81, 73, 0.1)',
    borderLeft: '3px solid rgb(207, 34, 46)',
    borderRight: '3px solid rgb(207, 34, 46)',
  },
  '&dark .cm-insertedChunk': {
    backgroundColor: 'rgba(46, 160, 67, 0.15)',
    borderLeft: '3px solid rgb(46, 160, 67)',
    borderRight: '3px solid rgb(46, 160, 67)',
  },
  '&light .cm-insertedChunk': {
    backgroundColor: 'rgba(46, 160, 67, 0.1)',
    borderLeft: '3px solid rgb(26, 127, 55)',
    borderRight: '3px solid rgb(26, 127, 55)',
  },
  '&dark .cm-deletedText': {
    backgroundColor: 'rgba(248, 81, 73, 0.3)',
    color: '#ffd7d5',
  },
  '&light .cm-deletedText': {
    backgroundColor: 'rgba(248, 81, 73, 0.2)',
    color: '#8c2f39',
  },
  '&dark .cm-insertedText': {
    backgroundColor: 'rgba(46, 160, 67, 0.3)',
    color: '#c8f2d1',
  },
  '&light .cm-insertedText': {
    backgroundColor: 'rgba(46, 160, 67, 0.2)',
    color: '#1f5e32',
  },
  '.cm-mergeView': {
    height: '100%',
    display: 'flex',
  },
  '.cm-mergeView .cm-editor': {
    height: '100%',
    flex: 1,
    minWidth: 0,
  },
  '.cm-mergeView .cm-mergeView-gap': {
    flex: '0 0 1px',
    backgroundColor: 'transparent',
  },
  '.cm-mergeView-chunk': {
    position: 'relative',
  },
  '.cm-mergeView-chunk .cm-revertButton': {
    position: 'absolute',
    top: '2px',
    right: '2px',
    cursor: 'pointer',
    opacity: '0.3',
    transition: 'opacity 0.15s',
    backgroundColor: 'var(--background)',
    border: 'none',
    borderRadius: '4px',
    padding: '2px 6px',
    fontSize: '11px',
    color: 'var(--foreground)',
  },
  '.cm-mergeView-chunk .cm-revertButton:hover': {
    opacity: '1',
    backgroundColor: 'var(--muted)',
  },
  '.cm-mergeView-chunk .cm-revertButton:focus': {
    outline: '2px solid var(--primary)',
    outlineOffset: '2px',
  },
});

const scrollSyncCompartment = new Compartment();

const createScrollSyncExtension = () => {
  return scrollSyncCompartment.of([]);
};

export const DiffMergeView = forwardRef<MergeViewEditorHandle, DiffMergeViewProps>(({
  original,
  modified,
  language = 'typescript',
  className,
  autoFocus = false,
  onChange,
  onEditorReady,
  revertControls = 'a-to-b',
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);
  const onChangeRef = useRef(onChange);
  const syncingRef = useRef<'a' | 'b' | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!containerRef.current) return;

    const languageExt = resolveLanguageExtension(language);
    const baseTheme = createEditorTheme(true);
    const diffTheme = createDiffTheme();

    const mergeView = new MergeView({
      a: {
        doc: original,
        extensions: [
          basicSetup,
          oneDark,
          baseTheme,
          diffTheme,
          languageExt,
          EditorState.readOnly.of(true),
          createScrollSyncExtension(),
        ],
      },
      b: {
        doc: modified,
        extensions: [
          basicSetup,
          oneDark,
          baseTheme,
          diffTheme,
          languageExt,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            onChangeRef.current?.(update.state.doc.toString());
          }),
          createScrollSyncExtension(),
        ],
      },
      parent: containerRef.current,
      revertControls,
      highlightChanges: true,
      gutter: true,
    });

    mergeViewRef.current = mergeView;

    const handle: MergeViewEditorHandle = {
      a: mergeView.a,
      b: mergeView.b,
      dom: mergeView.dom,
    };

    onEditorReady?.(handle);

    if (autoFocus) {
      mergeView.b.focus();
    }

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
      onEditorReady?.(null);
      mergeView.destroy();
      mergeViewRef.current = null;
    };
  }, [language, revertControls, autoFocus]);

  // Handle original content update
  useEffect(() => {
    const mergeView = mergeViewRef.current;
    if (!mergeView) return;

    const currentOriginal = mergeView.a.state.doc.toString();
    if (currentOriginal === original) return;

    mergeView.a.dispatch({
      changes: {
        from: 0,
        to: currentOriginal.length,
        insert: original,
      },
    });
  }, [original]);

  // Handle modified content update
  useEffect(() => {
    const mergeView = mergeViewRef.current;
    if (!mergeView) return;

    const currentModified = mergeView.b.state.doc.toString();
    if (currentModified === modified) return;

    mergeView.b.dispatch({
      changes: {
        from: 0,
        to: currentModified.length,
        insert: modified,
      },
    });
  }, [modified]);

  useImperativeHandle(ref, () => {
    const mergeView = mergeViewRef.current;
    if (!mergeView) {
      throw new Error('MergeView not initialized');
    }
    return {
      a: mergeView.a,
      b: mergeView.b,
      dom: mergeView.dom,
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn(
        'h-full overflow-hidden rounded-md border border-border',
        className
      )}
    />
  );
});

DiffMergeView.displayName = 'DiffMergeView';

export default DiffMergeView;