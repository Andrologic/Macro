import React from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey } from 'lexical';
import type { ContextRefKind } from '../../../types';
import { useChatStore } from '../../../stores/useChatStore';
import { Icon, type IconName } from '../../ui/Icon';
import { cn } from '../../../utils/cn';
import { $isMentionNode } from './MentionNode';

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
  const [editor] = useLexicalComposerContext();
  const config = KIND_CONFIG[kind];

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

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 mx-0.5',
        'text-xs leading-5 align-middle cursor-default',
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
      <button
        type="button"
        onMouseDown={handleRemove}
        className="ml-0.5 rounded-sm p-px opacity-50 hover:opacity-100 hover:bg-primary/15 transition-opacity"
        tabIndex={-1}
      >
        <Icon name="x" size={10} />
      </button>
    </span>
  );
};
