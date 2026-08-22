import React from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey, $isTextNode } from 'lexical';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../ui/Icon';
import { $isGoalCommandNode } from './GoalCommandNode';

interface GoalCommandMarkerProps {
  nodeKey: string;
}

export const GoalCommandMarker: React.FC<GoalCommandMarkerProps> = ({ nodeKey }) => {
  const [editor] = useLexicalComposerContext();
  const { t } = useTranslation();

  const handleRemove = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isGoalCommandNode(node)) return;

      const parent = node.getParent();
      const nextSibling = node.getNextSibling();
      if ($isTextNode(nextSibling) && nextSibling.getTextContent().startsWith(' ')) {
        const nextText = nextSibling.getTextContent().slice(1);
        if (nextText) {
          nextSibling.setTextContent(nextText);
          node.remove();
          nextSibling.selectStart();
          return;
        }
        nextSibling.remove();
      }
      node.remove();
      parent?.selectStart();
    });
    editor.focus();
  };

  return (
    <button
      type="button"
      data-goal-command-marker="true"
      onMouseDown={handleRemove}
      className="inline-flex h-5 w-5 select-none items-center justify-center align-middle text-primary/80 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
      tabIndex={-1}
      title={t('goal.commandHint', 'Start Goal mode and describe the objective')}
      aria-label={t('goal.removeCommand', 'Remove Goal command')}
    >
      <Icon name="target" size={14} />
    </button>
  );
};
