import React from 'react';
import type { ContextRefKind, Need } from '../../types';
import { cn } from '../../utils/cn';
import { NeedReferenceChip } from '../architect/NeedReferenceChip';
import { Icon, type IconName } from '../ui/Icon';

const KIND_CONFIG: Record<ContextRefKind, { label: string; icon: IconName; color: string; bg: string }> = {
  'need': { label: '', icon: 'target', color: 'text-yellow-500', bg: 'bg-yellow-500/10' },
  'plan-node': { label: 'Node', icon: 'circle-dot', color: 'text-blue-400', bg: 'bg-blue-400/10' },
  'predicted-branch': { label: 'Branch', icon: 'git-branch', color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
  'skill': { label: 'Skill', icon: 'sparkles', color: 'text-fuchsia-400', bg: 'bg-fuchsia-400/10' },
  'file': { label: 'File', icon: 'file-text', color: 'text-blue-400', bg: 'bg-blue-400/10' },
};

interface ContextReferenceChipProps {
  kind: ContextRefKind;
  title: string;
  need?: Need;
  priorityLabel?: string;
  renderAction?: React.ReactNode;
  surface?: 'composer' | 'message' | 'message-edit';
}

export const ContextReferenceChip: React.FC<ContextReferenceChipProps> = ({
  kind,
  title,
  need,
  priorityLabel,
  renderAction,
  surface = 'composer',
}) => {
  if (kind === 'need') {
    return (
      <NeedReferenceChip
        need={need}
        title={title}
        surface={surface}
        renderAction={renderAction}
        priorityLabel={priorityLabel}
      />
    );
  }

  const config = KIND_CONFIG[kind];

  return (
    <span
      data-context-reference-kind={kind}
      data-context-reference-surface={surface}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border mx-0.5',
        'text-xs leading-none cursor-default',
        'bg-primary/8 border-primary/20',
        surface === 'composer'
          ? 'h-[1.375rem] px-1.5 align-[0em]'
          : 'h-[1.125rem] px-1 align-[0em]'
      )}
    >
      <span
        className={cn(
          'inline-flex items-center gap-0.5 rounded px-1 py-px',
          'text-[9px] font-bold uppercase tracking-wider',
          config.color,
          config.bg
        )}
      >
        <Icon name={config.icon} size={10} />
        {config.label && <span>{config.label}</span>}
      </span>
      <span className="max-w-[130px] truncate text-foreground/90">{title}</span>
      {renderAction}
    </span>
  );
};
