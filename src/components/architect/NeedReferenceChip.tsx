import React from 'react';
import type { Need, NeedCategory } from '../../types';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';

export const NEED_CATEGORY_ICONS: Record<NeedCategory, IconName> = {
  functional: 'target',
  technical: 'code',
  ux: 'palette',
  performance: 'zap',
  security: 'shield',
  data: 'database',
  business: 'milestone',
  other: 'more-horizontal',
};

export const NEED_CATEGORY_COLORS: Record<NeedCategory, string> = {
  functional: 'text-blue-500',
  technical: 'text-slate-500',
  ux: 'text-purple-500',
  performance: 'text-amber-500',
  security: 'text-red-500',
  data: 'text-emerald-500',
  business: 'text-indigo-500',
  other: 'text-muted-foreground',
};

const NEED_PRIORITY_CLASSES: Record<Need['priority'], string> = {
  high: 'border-red-500/20 text-red-500 bg-red-500/5',
  medium: 'border-amber-500/20 text-amber-500 bg-amber-500/5',
  low: 'border-emerald-500/20 text-emerald-500 bg-emerald-500/5',
};

interface NeedReferenceChipProps {
  need?: Need;
  title: string;
  category?: NeedCategory;
  priority?: Need['priority'];
  tags?: string[];
  surface: 'card' | 'composer' | 'message' | 'message-edit';
  selected?: boolean;
  className?: string;
  onClick?: () => void;
  renderAction?: React.ReactNode;
  priorityLabel?: string;
}

export const NeedReferenceChip: React.FC<NeedReferenceChipProps> = ({
  need,
  title,
  category,
  priority,
  tags,
  surface,
  selected = false,
  className,
  onClick,
  renderAction,
  priorityLabel,
}) => {
  const resolvedTitle = need?.title ?? title;
  const resolvedCategory = need?.category ?? category;
  const resolvedPriority = need?.priority ?? priority;
  const resolvedTags = need?.tags ?? tags ?? [];
  const description = need?.description;

  if (surface === 'composer' || surface === 'message' || surface === 'message-edit') {
    const iconName = resolvedCategory ? NEED_CATEGORY_ICONS[resolvedCategory] : 'target';
    const iconColorClass = resolvedCategory ? NEED_CATEGORY_COLORS[resolvedCategory] : 'text-primary';

    return (
      <span
        data-need-reference-surface={surface}
        className={cn(
          'mx-0.5 inline-flex max-w-[240px] items-center rounded-md border',
          'align-middle text-xs leading-none cursor-default',
          'bg-card/80 border-border/80 shadow-sm',
          surface === 'composer'
            ? 'h-6 gap-1.5 px-1.5 translate-y-[-0.5px]'
            : 'h-5 gap-1 px-1.5',
          className
        )}
      >
        <span
          className={cn(
            'inline-flex shrink-0 items-center justify-center',
            surface === 'composer' ? 'h-4 w-4' : 'h-3.5 w-3.5'
          )}
        >
          <Icon
            name={iconName}
            size={surface === 'composer' ? 12 : 10}
            className={cn('stroke-[2.25]', iconColorClass)}
          />
        </span>
        <span className="min-w-0 max-w-[130px] truncate font-medium text-foreground/90">
          {resolvedTitle}
        </span>
        {renderAction}
      </span>
    );
  }

  return (
    <div
      onClick={onClick}
      className={cn(
        'group relative rounded-lg border p-3 transition-all duration-200',
        onClick && 'cursor-pointer hover:shadow-sm',
        selected
          ? 'bg-accent border-primary/50'
          : 'bg-card border-border hover:border-border/80 hover:bg-accent/50',
        className
      )}
    >
      <div className="mb-1.5 flex items-start justify-between gap-3">
        <h3 className="line-clamp-2 text-sm font-medium leading-tight text-foreground">
          {resolvedTitle}
        </h3>
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/50 bg-muted">
          <Icon
            name={NEED_CATEGORY_ICONS[resolvedCategory ?? 'other']}
            size={12}
            className="text-muted-foreground"
          />
        </div>
      </div>

      {description && (
        <p className="mb-2 line-clamp-2 text-xs text-muted-foreground">
          {description}
        </p>
      )}

      <div className="flex items-center gap-2">
        {resolvedPriority && (
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
              NEED_PRIORITY_CLASSES[resolvedPriority]
            )}
          >
            {priorityLabel ?? resolvedPriority}
          </span>
        )}
        {resolvedTags.slice(0, 2).map((tag) => (
          <span
            key={tag}
            className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            #{tag}
          </span>
        ))}
        {resolvedTags.length > 2 && (
          <span className="text-[10px] text-muted-foreground">
            +{resolvedTags.length - 2}
          </span>
        )}
      </div>
    </div>
  );
};
