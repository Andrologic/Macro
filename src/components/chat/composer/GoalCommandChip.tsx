import React from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey, $isTextNode } from 'lexical';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../ui/Icon';
import { $isGoalCommandNode } from './GoalCommandNode';

interface GoalCommandChipProps {
  nodeKey: string;
}

export const GoalCommandChip: React.FC<GoalCommandChipProps> = ({ nodeKey }) => {
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
    <span
      data-goal-command-chip="true"
      className="mx-1 inline-flex h-7 select-none items-center gap-1.5 rounded-lg bg-primary px-2 align-middle text-xs font-semibold leading-none text-primary-foreground shadow-sm"
      title={t('goal.commandHint', 'Start Goal mode and describe the objective')}
    >
      <Icon name="target" size={12} />
      <span>{t('goal.modeLabel', 'Goal mode')}</span>
      <button
        type="button"
        onMouseDown={handleRemove}
        className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded-md text-primary-foreground/70 transition-colors hover:bg-primary-foreground/15 hover:text-primary-foreground"
        tabIndex={-1}
        aria-label={t('goal.removeCommand', 'Remove Goal command')}
      >
        <Icon name="x" size={11} />
      </button>
    </span>
  );
};
