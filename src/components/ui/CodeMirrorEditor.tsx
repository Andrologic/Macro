import React, { useRef, useEffect } from 'react';
import { Decoration, EditorView } from '@codemirror/view';
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import type { CodeOverflowMode } from '../../types';
import { cn } from '../../utils/cn';
import { useAppStore } from '../../stores/useAppStore';
import { useOptionalTheme } from '../theme/ThemeProvider';
import {
  createCodeMirrorBaseTheme,
  getCodeMirrorThemeMetadata,
  getCodeMirrorSyntaxExtensions,
} from './codeMirrorTheme';

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
  overflowMode?: CodeOverflowMode;
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
  overflowMode,
  autoFocus = false,
  onEditorReady,
  lineHighlights = [],
  hideVerticalScrollbar = false,
}) => {
  const globalOverflowMode = useAppStore((state) => state.codeOverflowMode);
  const themeContext = useOptionalTheme();
  const themeMetadata = getCodeMirrorThemeMetadata(themeContext?.theme);
  const resolvedOverflowMode = overflowMode ?? globalOverflowMode;
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

    const baseTheme = createCodeMirrorBaseTheme(themeContext?.theme, {
      hideVerticalScrollbar,
    });
    const syntaxThemeExtensions = getCodeMirrorSyntaxExtensions(themeContext?.theme);

    const state = EditorState.create({
      doc: latestCodeRef.current,
      extensions: [
        basicSetup,
        ...syntaxThemeExtensions,
        resolveLanguageExtension(language),
        ...(resolvedOverflowMode === 'wrap' ? [EditorView.lineWrapping] : []),
        baseTheme,
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
  }, [autoFocus, hideVerticalScrollbar, language, onEditorReady, readOnly, resolvedOverflowMode, themeContext?.theme]);

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
      data-overflow-mode={resolvedOverflowMode}
      style={themeMetadata.surfaceVars as React.CSSProperties}
      className={cn(
        'w-full min-w-0 rounded-md overflow-hidden border border-border',
        className
      )}
    />
  );
};

// Export both named and default for lazy loading compatibility
export default CodeMirrorEditor;
