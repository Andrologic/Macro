import React, { useRef, useEffect } from 'react';
import { Decoration, EditorView } from '@codemirror/view';
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { oneDark } from '@codemirror/theme-one-dark';
import { cn } from '../../utils/cn';

// =============================================================================
// CODEMIRROR EDITOR COMPONENT
// =============================================================================

export interface CodeViewerLineHighlight {
  lineNumber: number;
  className: string;
}

interface CodeMirrorEditorProps {
  code: string;
  language?: string;
  className?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  wrapLines?: boolean;
  autoFocus?: boolean;
  onEditorReady?: (view: EditorView | null) => void;
  lineHighlights?: CodeViewerLineHighlight[];
  hideVerticalScrollbar?: boolean;
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

const buildLineHighlightExtension = (
  doc: EditorState['doc'],
  lineHighlights: CodeViewerLineHighlight[]
) => {
  const builder = new RangeSetBuilder<Decoration>();

  lineHighlights.forEach(({ lineNumber, className }) => {
    if (!Number.isFinite(lineNumber) || lineNumber < 1 || lineNumber > doc.lines) {
      return;
    }

    const line = doc.line(lineNumber);
    builder.add(
      line.from,
      line.from,
      Decoration.line({
        attributes: { class: className },
      })
    );
  });

  return EditorView.decorations.of(builder.finish());
};

/**
 * CodeMirrorEditor - Heavy code editor component
 * 
 * PERFORMANCE:
 * - Loaded lazily via CodeViewer wrapper
 * - Contains all CodeMirror dependencies (~500KB+)
 * - Only rendered when code display is actually needed
 */
const CodeMirrorEditor: React.FC<CodeMirrorEditorProps> = ({
  code,
  language = 'typescript',
  className,
  readOnly = true,
  onChange,
  wrapLines = true,
  autoFocus = false,
  onEditorReady,
  lineHighlights = [],
  hideVerticalScrollbar = false,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latestCodeRef = useRef(code);
  const onChangeRef = useRef(onChange);
  const latestLineHighlightsRef = useRef(lineHighlights);
  const highlightCompartmentRef = useRef(new Compartment());

  useEffect(() => {
    latestCodeRef.current = code;
  }, [code]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    latestLineHighlightsRef.current = lineHighlights;
  }, [lineHighlights]);

  useEffect(() => {
    if (!editorRef.current) return;

    const state = EditorState.create({
      doc: latestCodeRef.current,
      extensions: [
        basicSetup,
        oneDark,
        resolveLanguageExtension(language),
        ...(wrapLines ? [EditorView.lineWrapping] : []),
        EditorView.theme({
          '&': {
            fontSize: '13px',
            height: '100%',
          },
          '.cm-scroller': {
            overflow: 'auto',
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            ...(hideVerticalScrollbar
              ? {
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
              }
              : {}),
          },
          '.cm-scroller::-webkit-scrollbar': hideVerticalScrollbar ? {
            width: '0px',
            height: '10px',
          } : {},
          '.cm-scroller::-webkit-scrollbar-thumb': hideVerticalScrollbar ? {
            backgroundColor: 'rgba(148, 163, 184, 0.45)',
            borderRadius: '999px',
          } : {},
          '.cm-scroller::-webkit-scrollbar-track': hideVerticalScrollbar ? {
            backgroundColor: 'transparent',
          } : {},
          '.cm-scroller::-webkit-scrollbar-corner': hideVerticalScrollbar ? {
            backgroundColor: 'transparent',
          } : {},
          '.cm-scroller::-webkit-scrollbar:vertical': hideVerticalScrollbar ? {
            width: '0px',
          } : {},
          '.cm-content': {
            minHeight: '100%',
            padding: '12px 24px 16px 12px',
          },
          '.cm-gutters': {
            minHeight: '100%',
            paddingTop: '12px',
            paddingBottom: '16px',
          },
          '.cm-line.cm-git-added': {
            backgroundColor: 'rgba(34, 197, 94, 0.14)',
            boxShadow: 'inset 3px 0 0 rgba(34, 197, 94, 0.7)',
          },
          '.cm-line.cm-git-removed': {
            backgroundColor: 'rgba(239, 68, 68, 0.14)',
            boxShadow: 'inset 3px 0 0 rgba(239, 68, 68, 0.7)',
          },
        }),
        highlightCompartmentRef.current.of(
          buildLineHighlightExtension(
            EditorState.create({ doc: latestCodeRef.current }).doc,
            latestLineHighlightsRef.current
          )
        ),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          onChangeRef.current?.(update.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;
    onEditorReady?.(view);

    if (autoFocus) {
      view.focus();
    }

    return () => {
      onEditorReady?.(null);
      view.destroy();
      viewRef.current = null;
    };
  }, [autoFocus, hideVerticalScrollbar, language, onEditorReady, readOnly, wrapLines]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const current = view.state.doc.toString();
    if (current === code) return;

    view.dispatch({
      changes: {
        from: 0,
        to: current.length,
        insert: code,
      },
    });
  }, [code]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    view.dispatch({
      effects: highlightCompartmentRef.current.reconfigure(
        buildLineHighlightExtension(view.state.doc, lineHighlights)
      ),
    });
  }, [code, lineHighlights]);

  return (
    <div
      ref={editorRef}
      className={cn(
        'rounded-md overflow-hidden border border-border',
        className
      )}
    />
  );
};

// Export both named and default for lazy loading compatibility
export default CodeMirrorEditor;
