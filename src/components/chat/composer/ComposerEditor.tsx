import React, { useEffect, useImperativeHandle, forwardRef, useRef, useCallback } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getNodeByKey,
  $createParagraphNode,
  $createTextNode,
  $createLineBreakNode,
  $getSelection,
  $isRangeSelection,
  type ElementNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  FORMAT_TEXT_COMMAND,
  type EditorState,
  type NodeMutation,
} from 'lexical';
import { useChatStore } from '../../../stores/useChatStore';
import type { ContextRefKind } from '../../../types';
import { cn } from '../../../utils/cn';
import { MentionNode, $createMentionNode, type MentionSurface } from './MentionNode';
import { MentionPlugin } from './MentionPlugin';
import { SlashContextMenuPlugin } from './SlashContextMenuPlugin';

// ------ Types ------

export interface ComposerEditorHandle {
  clear: () => void;
  setText: (text: string) => void;
  getTextContent: () => string;
  focus: () => void;
}

interface ComposerEditorProps {
  editable: boolean;
  placeholder: string;
  onTextChange: (text: string) => void;
  onSend: () => void;
  onPromptHistory?: (direction: 'up' | 'down') => void;
  className?: string;
  surface?: MentionSurface;
  syncContextRefs?: boolean;
}

// ------ Theme ------

const composerTheme = {
  root: 'composer-editor-root',
  paragraph: 'composer-editor-paragraph',
};

const initializeComposerState = () => {
  const root = $getRoot();
  if (root.getFirstChild() !== null) {
    return;
  }

  root.append($createParagraphNode());
};

const EDITOR_CONTEXT_MENTION_PATTERN = /\[(need|skill|file|plan-node|predicted-branch):\s*([^\]]+)\]/gi;

const appendTextWithContextReferences = (
  parent: ElementNode,
  text: string,
  surface: MentionSurface,
  syncContextRefs: boolean
) => {
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const pattern = new RegExp(EDITOR_CONTEXT_MENTION_PATTERN);

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.append($createTextNode(text.slice(lastIndex, match.index)));
    }

    const kind = match[1]?.toLowerCase() as ContextRefKind | undefined;
    const title = match[2]?.trim() ?? '';
    if (kind && title) {
      parent.append(
        $createMentionNode(kind, title, title, {
          surface,
          syncContextRefs,
        })
      );
    } else {
      parent.append($createTextNode(match[0]));
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parent.append($createTextNode(text.slice(lastIndex)));
  }
};

const setEditorPlainText = (
  text: string,
  surface: MentionSurface,
  syncContextRefs: boolean
) => {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    if (index > 0) {
      paragraph.append($createLineBreakNode());
    }
    appendTextWithContextReferences(paragraph, line, surface, syncContextRefs);
  });

  root.append(paragraph);
  paragraph.selectEnd();
};

// ------ Inner component that accesses the editor ------

const InnerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  ({
    editable,
    placeholder,
    onTextChange,
    onSend,
    onPromptHistory,
    className,
    surface = 'composer',
    syncContextRefs = true,
  }, ref) => {
    const [editor] = useLexicalComposerContext();
    const textRef = useRef('');

    // Editable state
    useEffect(() => {
      editor.setEditable(editable);
    }, [editor, editable]);

    // Imperative handle for ChatZone
    useImperativeHandle(ref, () => ({
      clear: () => {
        editor.update(() => {
          setEditorPlainText('', surface, syncContextRefs);
        });
        textRef.current = '';
      },
      setText: (text: string) => {
        editor.update(() => {
          setEditorPlainText(text, surface, syncContextRefs);
        });
        textRef.current = text;
      },
      getTextContent: () => textRef.current,
      focus: () => editor.focus(),
    }), [editor, surface, syncContextRefs]);

    // On-change: extract plain text (MentionNodes serialize to [kind: title])
    const handleChange = useCallback(
      (editorState: EditorState) => {
        editorState.read(() => {
          const root = $getRoot();
          const text = root.getTextContent();
          textRef.current = text;
          onTextChange(text);
        });
      },
      [onTextChange]
    );

    // Enter key → send
    useEffect(() => {
      return editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null) => {
          if (event?.shiftKey) return false;
          event?.preventDefault();
          onSend();
          return true;
        },
        COMMAND_PRIORITY_HIGH
      );
    }, [editor, onSend]);

    // Block formatting shortcuts (Ctrl+B/I/U)
    useEffect(() => {
      return editor.registerCommand(
        FORMAT_TEXT_COMMAND,
        () => true, // swallow it
        COMMAND_PRIORITY_HIGH
      );
    }, [editor]);

    // Mutation listener: sync store when MentionNodes are destroyed
    // We keep a map of nodeKey → {refId, kind} so we can look up data after destruction
    const mentionMapRef = useRef<Map<string, { refId: string; kind: string }>>(new Map());
    useEffect(() => {
      if (!syncContextRefs) {
        return undefined;
      }
      return editor.registerMutationListener(
        MentionNode,
        (mutations: Map<string, NodeMutation>) => {
          for (const [nodeKey, mutation] of mutations) {
            if (mutation === 'created') {
              // Read the node data and cache it
              editor.getEditorState().read(() => {
                const node = $getNodeByKey(nodeKey);
                if (node && node instanceof MentionNode) {
                  mentionMapRef.current.set(nodeKey, {
                    refId: node.getRefId(),
                    kind: node.getKind(),
                  });
                }
              });
            } else if (mutation === 'destroyed') {
              const data = mentionMapRef.current.get(nodeKey);
              if (data) {
                useChatStore.getState().removeComposerContextRef(
                  data.refId,
                  data.kind as ContextRefKind
                );
                mentionMapRef.current.delete(nodeKey);
              }
            }
          }
        }
      );
    }, [editor, syncContextRefs]);

    // Prompt history via ArrowUp (when cursor at start)
    useEffect(() => {
      if (!onPromptHistory) return;
      return editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event: KeyboardEvent) => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) return false;
          const anchor = sel.anchor;
          // At the very start of the editor
          const root = $getRoot();
          const firstChild = root.getFirstChild();
          if (
            firstChild &&
            anchor.key === firstChild.getKey() &&
            anchor.offset === 0
          ) {
            event.preventDefault();
            onPromptHistory('up');
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH
      );
    }, [editor, onPromptHistory]);

    // Prompt history via ArrowDown (when cursor at end)
    useEffect(() => {
      if (!onPromptHistory) return;
      return editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event: KeyboardEvent) => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) return false;
          const anchor = sel.anchor;
          const root = $getRoot();
          const lastChild = root.getLastChild();
          if (lastChild) {
            const textLen = lastChild.getTextContentSize();
            if (
              anchor.key === lastChild.getKey() &&
              anchor.offset === textLen
            ) {
              event.preventDefault();
              onPromptHistory('down');
              return true;
            }
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH
      );
    }, [editor, onPromptHistory]);

    return (
      <>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              data-shortcut-chat-input="true"
              className={cn(
                'flex-1 min-w-[100px] bg-transparent border-0 outline-none text-sm text-foreground',
                'min-h-[32px] max-h-[120px] overflow-y-auto px-1 py-1 leading-[1.35]',
                '[&_.composer-editor-paragraph]:m-0 [&_.composer-editor-paragraph]:min-h-[1.35em]',
                !editable && 'opacity-50 cursor-not-allowed',
                className
              )}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute top-0 left-0 px-1 py-1 text-sm leading-[1.35] text-muted-foreground select-none">
              {placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
        <HistoryPlugin />
        {syncContextRefs && <MentionPlugin />}
        {syncContextRefs && surface === 'composer' && <SlashContextMenuPlugin />}
      </>
    );
  }
);
InnerEditor.displayName = 'InnerEditor';

// Simple error boundary
function LexicalErrorBoundary({ children }: { children: React.ReactNode; onError?: (e: Error) => void }) {
  return <>{children}</>;
}

// ------ Main exported component ------

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  (props, ref) => {
    const initialConfig = {
      namespace: 'MacroComposer',
      theme: composerTheme,
      nodes: [MentionNode],
      editorState: initializeComposerState,
      onError: (error: Error) => {
        console.error('[ComposerEditor]', error);
      },
    };

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <div className="relative flex-1">
          <InnerEditor ref={ref} {...props} />
        </div>
      </LexicalComposer>
    );
  }
);
ComposerEditor.displayName = 'ComposerEditor';
