import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  createEditor,
  type EditorState,
  type EditorThemeClasses,
  type HTMLConfig,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  type LexicalNodeReplacement,
} from 'lexical';
import {
  createLexicalComposerContext,
  LexicalComposerContext,
  type LexicalComposerContextWithEditor,
} from '@lexical/react/LexicalComposerContext';
import { type ReactNode, useEffect, useLayoutEffect, useState } from 'react';

type InitialEditorStateType =
  | null
  | string
  | EditorState
  | ((editor: LexicalEditor) => void);

type InitialConfigType = Readonly<{
  namespace: string;
  nodes?: ReadonlyArray<Klass<LexicalNode> | LexicalNodeReplacement>;
  onError: (error: Error, editor: LexicalEditor) => void;
  editable?: boolean;
  theme?: EditorThemeClasses;
  editorState?: InitialEditorStateType;
  html?: HTMLConfig;
}>;

interface SafeLexicalComposerProps {
  initialConfig: InitialConfigType;
  children: ReactNode;
}

const CAN_USE_DOM =
  typeof window !== 'undefined' &&
  typeof window.document !== 'undefined' &&
  typeof window.document.createElement !== 'undefined';

const useLayoutEffectImpl = CAN_USE_DOM ? useLayoutEffect : useEffect;

// Keep the tag literal local. Importing HISTORY_MERGE_TAG from `lexical`
// can create a Bun test initialization cycle with @lexical/react.
const HISTORY_MERGE_OPTIONS = { tag: 'history-merge' } as const;

const initializeEditor = (
  editor: LexicalEditor,
  initialEditorState: InitialEditorStateType | undefined
) => {
  if (initialEditorState === null) {
    return;
  }

  if (initialEditorState === undefined) {
    editor.update(() => {
      const root = $getRoot();
      if (!root.isEmpty()) {
        return;
      }

      const paragraph = $createParagraphNode();
      root.append(paragraph);

      const activeElement = CAN_USE_DOM ? document.activeElement : null;
      if ($getSelection() !== null || activeElement === editor.getRootElement()) {
        paragraph.select();
      }
    }, HISTORY_MERGE_OPTIONS);
    return;
  }

  if (typeof initialEditorState === 'string') {
    const parsedEditorState = editor.parseEditorState(initialEditorState);
    editor.setEditorState(parsedEditorState, HISTORY_MERGE_OPTIONS);
    return;
  }

  if (typeof initialEditorState === 'object') {
    editor.setEditorState(initialEditorState, HISTORY_MERGE_OPTIONS);
    return;
  }

  editor.update(() => {
    const root = $getRoot();
    if (root.isEmpty()) {
      initialEditorState(editor);
    }
  }, HISTORY_MERGE_OPTIONS);
};

const createInitialComposerContext = (
  initialConfig: InitialConfigType
): LexicalComposerContextWithEditor => {
  const {
    theme,
    namespace,
    nodes,
    onError,
    editorState: initialEditorState,
    html,
  } = initialConfig;

  const context = createLexicalComposerContext(null, theme);
  let editor!: LexicalEditor;
  editor = createEditor({
    editable: initialConfig.editable,
    html,
    namespace,
    nodes,
    onError: (error) => onError(error, editor),
    theme,
  });

  initializeEditor(editor, initialEditorState);

  return [editor, context];
};

export const LexicalComposer = ({ initialConfig, children }: SafeLexicalComposerProps) => {
  const [composerContext] = useState(() => createInitialComposerContext(initialConfig));

  useLayoutEffectImpl(() => {
    const isEditable = initialConfig.editable;
    const [editor] = composerContext;
    editor.setEditable(isEditable !== undefined ? isEditable : true);
  }, [composerContext, initialConfig.editable]);

  return (
    <LexicalComposerContext.Provider value={composerContext}>
      {children}
    </LexicalComposerContext.Provider>
  );
};
