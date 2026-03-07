import React, { useRef, useEffect } from 'react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { oneDark } from '@codemirror/theme-one-dark';
import { cn } from '../../utils/cn';

// =============================================================================
// CODEMIRROR EDITOR COMPONENT
// =============================================================================

interface CodeMirrorEditorProps {
  code: string;
  language?: string;
  className?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
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
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latestCodeRef = useRef(code);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    latestCodeRef.current = code;
  }, [code]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!editorRef.current) return;

    const state = EditorState.create({
      doc: latestCodeRef.current,
      extensions: [
        basicSetup,
        oneDark,
        resolveLanguageExtension(language),
        EditorView.lineWrapping,
        EditorView.theme({
          '&': {
            fontSize: '13px',
          },
          '.cm-scroller': {
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          },
        }),
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

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [language, readOnly]);

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
