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
  language?: 'javascript' | 'typescript' | 'rust';
  className?: string;
  readOnly?: boolean;
}

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
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;

    const languageExtension =
      language === 'rust'
        ? rust()
        : javascript({ jsx: true, typescript: language === 'typescript' });

    const state = EditorState.create({
      doc: code,
      extensions: [
        basicSetup,
        oneDark,
        languageExtension,
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
  }, [code, language, readOnly]);

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
