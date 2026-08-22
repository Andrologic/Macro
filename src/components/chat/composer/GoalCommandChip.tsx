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
      className="mx-0.5 inline-flex h-[1.45rem] select-none items-center gap-1 rounded-md border border-primary/35 bg-primary/10 px-1.5 align-[-0.05em] text-[11px] font-semibold leading-none text-primary shadow-[0_0_0_1px_rgb(var(--primary)/0.06),0_0_16px_rgb(var(--primary)/0.08)]"
      title={t('goal.commandHint', 'Start Goal mode and describe the objective')}
    >
      <span className="relative flex h-4 w-4 items-center justify-center rounded bg-primary/15">
        <Icon name="target" size={10} />
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary ring-1 ring-background"
        />
      </span>
      <span>Goal</span>
      <button
        type="button"
        onMouseDown={handleRemove}
        className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-sm text-primary/55 transition-colors hover:bg-primary/15 hover:text-primary"
        tabIndex={-1}
        aria-label={t('goal.removeCommand', 'Remove Goal command')}
      >
        <Icon name="x" size={9} />
      </button>
    </span>
  );
};
