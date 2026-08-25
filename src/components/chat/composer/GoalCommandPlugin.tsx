import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createTextNode, TextNode } from 'lexical';
import { useEffect } from 'react';
import { $createGoalCommandNode } from './GoalCommandNode';

// Wait for the separator before converting. Converting the exact `/goal` prefix
// would prevent a user from continuing to type a lookalike such as `/goals`.
const GOAL_COMMAND_PREFIX = /^(\s*)\/goal(?=\s)/i;

export const transformGoalCommandTextNode = (node: TextNode) => {
  if (node.getPreviousSibling() || node.getParent()?.getPreviousSibling()) return;

  const text = node.getTextContent();
  const match = GOAL_COMMAND_PREFIX.exec(text);
  if (!match) return;

  const leadingWhitespace = match[1] ?? '';
  const remainder = text.slice(match[0].length) || ' ';
  const remainderNode = $createTextNode(remainder);
  const goalNode = $createGoalCommandNode();
  if (leadingWhitespace) {
    const leadingNode = $createTextNode(leadingWhitespace);
    node.replace(leadingNode);
    leadingNode.insertAfter(goalNode);
  } else {
    node.replace(goalNode);
  }
  goalNode.insertAfter(remainderNode);
  remainderNode.selectEnd();
};

export const GoalCommandPlugin = () => {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () => editor.registerNodeTransform(TextNode, transformGoalCommandTextNode),
    [editor],
  );

  return null;
};
