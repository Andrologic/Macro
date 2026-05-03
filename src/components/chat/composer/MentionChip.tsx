import React from 'react';
import { useTranslation } from 'react-i18next';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey } from 'lexical';
import type { ContextRefKind, Need } from '../../../types';
import { useChatStore } from '../../../stores/useChatStore';
import { Icon, type IconName } from '../../ui/Icon';
import { cn } from '../../../utils/cn';
import { $isMentionNode } from './MentionNode';
import { NeedReferenceChip } from '../../architect/NeedReferenceChip';

const KIND_CONFIG: Record<ContextRefKind, { label: string; icon: IconName; color: string; bg: string }> = {
  'need': { label: '', icon: 'target', color: 'text-yellow-500', bg: 'bg-yellow-500/10' },
  'plan-node': { label: 'Node', icon: 'circle-dot', color: 'text-blue-400', bg: 'bg-blue-400/10' },
  'predicted-branch': { label: 'Branch', icon: 'git-branch', color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
};

interface MentionChipProps {
  nodeKey: string;
  kind: ContextRefKind;
  refId: string;
  title: string;
}

export const MentionChip: React.FC<MentionChipProps> = ({ nodeKey, kind, refId, title }) => {
  const { t } = useTranslation();
  const [editor] = useLexicalComposerContext();
  const config = KIND_CONFIG[kind];
  const contextRef = useChatStore((state) =>
    state.composerContextRefs.find((ref) => ref.id === refId && ref.kind === kind)
  );
  const need = kind === 'need' && contextRef?.data && 'category' in contextRef.data
    ? contextRef.data as Need
    : undefined;

  const handleRemove = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isMentionNode(node)) {
        node.remove();
      }
    });
    useChatStore.getState().removeComposerContextRef(refId, kind);
  };

  const removeButton = (
    <button
      type="button"
      onMouseDown={handleRemove}
      className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm opacity-50 transition-opacity hover:bg-primary/15 hover:opacity-100"
      tabIndex={-1}
    >
      <Icon name="x" size={10} />
    </button>
  );

  if (kind === 'need') {
    return (
      <NeedReferenceChip
        need={need}
        title={title}
        surface="composer"
        renderAction={removeButton}
        priorityLabel={need ? t(`architect.needPriority.${need.priority}`, need.priority) : undefined}
      />
    );
  }

  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-md border px-1.5 mx-0.5',
        'text-xs leading-none align-[-0.1875rem] cursor-default',
        'bg-primary/8 border-primary/20'
      )}
    >
      {/* Kind badge */}
      <span
        className={cn(
          'inline-flex items-center gap-0.5 rounded px-1 py-px',
          'text-[9px] font-bold uppercase tracking-wider',
          config.color, config.bg
        )}
      >
        <Icon name={config.icon} size={10} />
        {config.label && <span>{config.label}</span>}
      </span>

      {/* Title */}
      <span className="max-w-[130px] truncate text-foreground/90">{title}</span>

      {/* Remove button */}
      {removeButton}
    </span>
  );
};
