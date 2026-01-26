import React, { useRef, useEffect } from 'react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { oneDark } from '@codemirror/theme-one-dark';
import { cn } from '../../utils/cn';

interface CodeViewerProps {
  code: string;
  language?: 'javascript' | 'typescript' | 'rust';
  className?: string;
}

export const CodeViewer: React.FC<CodeViewerProps> = ({
  code,
  language = 'typescript',
  className,
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
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
    };
  }, [code, language]);

  return (
    <div
      ref={editorRef}
      className={cn('rounded-lg overflow-hidden border border-border', className)}
    />
  );
};
