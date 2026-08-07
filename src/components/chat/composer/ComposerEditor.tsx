import React, { useEffect, useImperativeHandle, forwardRef, useRef, useCallback } from 'react';
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
  $setSelection,
  $isElementNode,
  $isRangeSelection,
  type ElementNode,
  type LexicalNode,
  type PointType,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  FORMAT_TEXT_COMMAND,
  type EditorState,
  type NodeMutation,
} from 'lexical';
import { useChatStore } from '../../../stores/useChatStore';
import type { ContextRefKind, ContextReference } from '../../../types';
import { cn } from '../../../utils/cn';
import { MentionNode, $createMentionNode, type MentionSurface } from './MentionNode';
import { MentionPlugin } from './MentionPlugin';
import { LexicalComposer } from './SafeLexicalComposer';
import { SlashContextMenuPlugin } from './SlashContextMenuPlugin';
import {
  clearWindowSelection,
  domSelectionBelongsToElement,
} from './composerDomSelection';

// ------ Types ------

export interface ComposerEditorHandle {
  clear: () => void;
  setText: (text: string, contextRefs?: readonly ContextReference[]) => void;
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

// Keep these Lexical tag values local: importing update tag constants from
// `lexical` creates a Bun test initialization cycle with @lexical/react.
const LEXICAL_UPDATE_TAGS = {
  historyMerge: 'history-merge',
  skipDomSelection: 'skip-dom-selection',
  skipSelectionFocus: 'skip-selection-focus',
} as const;

const initializeComposerState = () => {
  const root = $getRoot();
  if (root.getFirstChild() !== null) {
    return;
  }

  root.append($createParagraphNode());
};

const EDITOR_CONTEXT_MENTION_PATTERN = /\[(need|skill|file|source|plan-node|predicted-branch):\s*([^\]]+)\]/gi;

const appendTextWithContextReferences = (
  parent: ElementNode,
  text: string,
  surface: MentionSurface,
  syncContextRefs: boolean,
  contextRefs: readonly ContextReference[] = [],
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
      const matchingRef = contextRefs.find(
        (ref) =>
          ref.kind === kind && (ref.title === title || ref.id === title),
      );
      parent.append(
        $createMentionNode(kind, matchingRef?.id ?? title, title, {
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
  syncContextRefs: boolean,
  options: {
    selectEnd?: boolean;
    contextRefs?: readonly ContextReference[];
  } = {},
) => {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    if (index > 0) {
      paragraph.append($createLineBreakNode());
    }
    appendTextWithContextReferences(
      paragraph,
      line,
      surface,
      syncContextRefs,
      options.contextRefs,
    );
  });

  root.append(paragraph);
  if (options.selectEnd ?? true) {
    paragraph.selectEnd();
  }
};

const getAbsoluteTextOffsetForPoint = (point: PointType): number | null => {
  const root = $getRoot();
  let offset = 0;

  const visit = (node: LexicalNode): boolean => {
    if (node.getKey() === point.key) {
      if (point.type === 'text') {
        offset += Math.min(point.offset, node.getTextContentSize());
        return true;
      }

      if ($isElementNode(node)) {
        const children = node.getChildren();
        const childLimit = Math.max(0, Math.min(point.offset, children.length));
        for (let index = 0; index < childLimit; index += 1) {
          offset += children[index]?.getTextContentSize() ?? 0;
        }
        return true;
      }

      return false;
    }

    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        const offsetBeforeChild = offset;
        if (visit(child)) {
          return true;
        }
        offset = offsetBeforeChild + child.getTextContentSize();
      }
      return false;
    }

    return false;
  };

  return visit(root) ? offset : null;
};

export const getCollapsedComposerSelectionTextPosition = (): {
  offset: number;
  total: number;
} | null => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const offset = getAbsoluteTextOffsetForPoint(selection.anchor);
  if (offset === null) {
    return null;
  }

  return {
    offset,
    total: $getRoot().getTextContentSize(),
  };
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
    const suppressMentionRefRemovalRef = useRef(false);

    const deferMentionRefRemovalResume = () => {
      void Promise.resolve().then(() => {
        suppressMentionRefRemovalRef.current = false;
      });
    };

    // Editable state
    useEffect(() => {
      editor.setEditable(editable);
    }, [editor, editable]);

    // Imperative handle for ChatZone
    useImperativeHandle(ref, () => ({
      clear: () => {
        const shouldClearDomSelection = domSelectionBelongsToElement(editor.getRootElement());
        editor.update(
          () => {
            setEditorPlainText('', surface, syncContextRefs, { selectEnd: false });
            $setSelection(null);
          },
          { tag: [LEXICAL_UPDATE_TAGS.skipDomSelection, LEXICAL_UPDATE_TAGS.historyMerge] }
        );
        if (shouldClearDomSelection) {
          clearWindowSelection();
        }
        textRef.current = '';
      },
      setText: (text: string, contextRefs?: readonly ContextReference[]) => {
        suppressMentionRefRemovalRef.current = true;
        try {
          editor.update(
            () => {
              setEditorPlainText(text, surface, syncContextRefs, {
                contextRefs:
                  contextRefs ?? useChatStore.getState().composerContextRefs,
              });
            },
            { tag: [LEXICAL_UPDATE_TAGS.skipSelectionFocus, LEXICAL_UPDATE_TAGS.historyMerge] }
          );
        } finally {
          deferMentionRefRemovalResume();
        }
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

    // Tab inserts an actual tab in the prompt. Slash menu completion overrides this.
    useEffect(() => {
      return editor.registerCommand(
        KEY_TAB_COMMAND,
        (event: KeyboardEvent) => {
          event.preventDefault();
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return false;
          selection.insertText('\t');
          return true;
        },
        COMMAND_PRIORITY_HIGH
      );
    }, [editor]);

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
              mentionMapRef.current.delete(nodeKey);
              if (data) {
                if (!suppressMentionRefRemovalRef.current) {
                  useChatStore.getState().removeComposerContextRef(
                    data.refId,
                    data.kind as ContextRefKind
                  );
                }
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
          const position = getCollapsedComposerSelectionTextPosition();
          if (position?.offset === 0) {
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
          const position = getCollapsedComposerSelectionTextPosition();
          if (position && position.offset === position.total) {
            event.preventDefault();
            onPromptHistory('down');
            return true;
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
                'min-h-[32px] max-h-[120px] overflow-y-auto px-1 py-[6.5px] leading-[1.35]',
                '[&_.composer-editor-paragraph]:m-0 [&_.composer-editor-paragraph]:min-h-[1.35em]',
                !editable && 'opacity-50 cursor-not-allowed',
                className
              )}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute top-0 left-0 px-1 py-[6.5px] text-sm leading-[1.35] text-muted-foreground select-none">
              {placeholder}
            </div>
          }
          ErrorBoundary={ComposerLexicalErrorBoundary}
        />
        <OnChangePlugin
          onChange={handleChange}
          ignoreSelectionChange
          ignoreHistoryMergeTagChange={false}
        />
        <HistoryPlugin />
        {syncContextRefs && <MentionPlugin />}
        {syncContextRefs && surface === 'composer' && <SlashContextMenuPlugin />}
      </>
    );
  }
);
InnerEditor.displayName = 'InnerEditor';

// ------ Main exported component ------

class ComposerLexicalErrorBoundary extends React.Component<
  { children: React.ReactElement; onError: (error: Error) => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) {
      return null;
    }

    return this.props.children;
  }
}

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
