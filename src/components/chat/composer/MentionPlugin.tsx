import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isElementNode,
  $createTextNode,
  $createParagraphNode,
  $nodesOfType,
} from 'lexical';
import { useChatStore } from '../../../stores/useChatStore';
import type { ContextRefKind } from '../../../types';
import { MentionNode, $createMentionNode, $isMentionNode } from './MentionNode';

interface InsertedComposerRef {
  id: string;
  kind: ContextRefKind;
  title: string;
}

const getComposerRefKey = (kind: ContextRefKind, id: string): string =>
  JSON.stringify([kind, id]);

/**
 * MentionPlugin — watches composerContextRefs in the store
 * and inserts/removes MentionNode chips in the Lexical editor accordingly.
 */
export const MentionPlugin: React.FC = () => {
  const [editor] = useLexicalComposerContext();
  const insertedRefsRef = useRef<Map<string, InsertedComposerRef>>(new Map());

  const composerContextRefs = useChatStore((s) => s.composerContextRefs);

  // Insert new chips at the cursor position
  useEffect(() => {
    const currentKeys = new Set(composerContextRefs.map((r) => getComposerRefKey(r.kind, r.id)));

    // Insert any new refs
    for (const ref of composerContextRefs) {
      const key = getComposerRefKey(ref.kind, ref.id);
      if (insertedRefsRef.current.has(key)) continue;
      insertedRefsRef.current.set(key, {
        id: ref.id,
        kind: ref.kind,
        title: ref.title,
      });

      editor.update(() => {
        const existingMention = $nodesOfType(MentionNode).some(
          (node) =>
            $isMentionNode(node) &&
            node.getKind() === ref.kind &&
            node.getRefId() === ref.id
        );
        if (existingMention) {
          return;
        }

        const mentionNode = $createMentionNode(ref.kind, ref.id, ref.title);
        const spaceAfter = $createTextNode(' ');

        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertNodes([mentionNode, spaceAfter]);
        } else {
          // Fallback: append to end of root
          const rootNode = $getRoot();
          const lastChild = rootNode.getLastChild();
          if (lastChild && $isElementNode(lastChild)) {
            lastChild.append(mentionNode, spaceAfter);
          } else {
            const para = $createParagraphNode();
            para.append(mentionNode, spaceAfter);
            rootNode.append(para);
          }
        }
      });
    }

    // Remove chips that were removed from the store
    for (const [key, insertedRef] of insertedRefsRef.current) {
      if (!currentKeys.has(key)) {
        insertedRefsRef.current.delete(key);
        // Remove from editor
        editor.update(() => {
          const mentions = $nodesOfType(MentionNode);
          for (const node of mentions) {
            if (
              $isMentionNode(node) &&
              node.getKind() === insertedRef.kind &&
              node.getRefId() === insertedRef.id
            ) {
              node.remove();
              break;
            }
          }
        });
      }
    }
  }, [composerContextRefs, editor]);

  return null;
};
