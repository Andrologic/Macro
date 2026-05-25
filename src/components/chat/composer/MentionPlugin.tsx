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
import { MentionNode, $createMentionNode, $isMentionNode } from './MentionNode';

/**
 * MentionPlugin — watches composerContextRefs in the store
 * and inserts/removes MentionNode chips in the Lexical editor accordingly.
 */
export const MentionPlugin: React.FC = () => {
  const [editor] = useLexicalComposerContext();
  const insertedKeysRef = useRef<Set<string>>(new Set());

  const composerContextRefs = useChatStore((s) => s.composerContextRefs);

  // Insert new chips at the cursor position
  useEffect(() => {
    const currentKeys = new Set(composerContextRefs.map((r) => `${r.kind}-${r.id}`));

    // Insert any new refs
    for (const ref of composerContextRefs) {
      const key = `${ref.kind}-${ref.id}`;
      if (insertedKeysRef.current.has(key)) continue;
      insertedKeysRef.current.add(key);

      editor.update(() => {
        const existingMention = $nodesOfType(MentionNode).some(
          (node) =>
            $isMentionNode(node) &&
            node.__kind === ref.kind &&
            (node.__refId === ref.id || node.getTitle() === ref.title)
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
    for (const key of insertedKeysRef.current) {
      if (!currentKeys.has(key)) {
        insertedKeysRef.current.delete(key);
        // Remove from editor
        const [kind] = key.split('-');
        // Reconstruct id (it may contain dashes)
        const refId = key.substring(kind.length + 1);
        editor.update(() => {
          const mentions = $nodesOfType(MentionNode);
          for (const node of mentions) {
            if ($isMentionNode(node) && node.__refId === refId && node.__kind === kind) {
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
