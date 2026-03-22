import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { formatDate } from '../../i18n/format';
import { GitCommit, CommitStatus } from '../../types';

interface GitGraphProps {
  commits: GitCommit[];
  selectedCommitId: string | null;
  onCommitClick?: (commit: GitCommit) => void;
}

const statusConfig: Record<CommitStatus, { icon: string; color: string; bgColor: string }> = {
  done: { icon: 'check', color: 'text-emerald-500', bgColor: 'bg-emerald-500' },
  planned: { icon: 'shield', color: 'text-primary', bgColor: 'bg-primary' },
  'in-progress': { icon: 'loader', color: 'text-amber-500', bgColor: 'bg-amber-500' },
};

export const GitGraph: React.FC<GitGraphProps> = ({
  commits,
  selectedCommitId,
  onCommitClick,
}) => {
  const { t } = useTranslation();

  if (commits.length === 0) {
    return (
      <div className="flex-1 items-center justify-center text-muted-foreground">
        <Icon name="git-commit" size={48} className="text-muted-foreground mx-auto mb-4" />
        <p className="text-sm">{t('git.noCommitsInBranch', 'No commits in this branch')}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <svg
        width="100%"
        height={`${commits.length * 80 + 100}px`}
        style={{ position: 'absolute', pointerEvents: 'none' }}
      >
        {commits.map((commit, index) => {
          const config = statusConfig[commit.status];
          const isSelected = selectedCommitId === commit.id;
          const x = 50;
          const y = 60 + (commits.length - 1 - index) * 80;

          return (
            <g key={commit.id}>
              {index < commits.length - 1 && (
                <line
                  x1={x}
                  y1={y + 20}
                  x2={x}
                  y2={y + 60}
                  stroke="rgb(var(--border) / 1)"
                  strokeWidth="2"
                />
              )}

              <circle
                cx={x}
                cy={y}
                r="18"
                className={cn(
                  'cursor-pointer transition-all duration-200'
                )}
                fill={config.bgColor}
                onClick={() => onCommitClick?.(commit)}
                style={{
                  stroke: isSelected ? 'rgb(var(--foreground) / 1)' : 'rgb(var(--border) / 1)',
                  strokeWidth: isSelected ? '3' : '2',
                }}
              />

              <text
                x={x + 35}
                y={y + 4}
                textAnchor="start"
                className="fill-muted-foreground pointer-events-none select-none"
                style={{
                  fontSize: '11px',
                  fontFamily: 'monospace',
                  fontWeight: '600',
                }}
              >
                {commit.hash.substring(0, 7)}
              </text>

              <text
                x={x + 100}
                y={y + 4}
                textAnchor="start"
                className={cn(
                  'fill-current pointer-events-none select-none',
                  isSelected ? 'fill-foreground' : 'fill-muted-foreground'
                )}
                style={{
                  fontSize: '12px',
                  fontWeight: '500',
                }}
              >
                {commit.message.length > 50
                  ? `${commit.message.substring(0, 50)}...`
                  : commit.message}
              </text>

              {isSelected && commit.task_id && (
                <rect
                  x={x + 35}
                  y={y + 20}
                  width="65"
                  height="20"
                  rx="4"
                  className="fill-card pointer-events-none"
                />
              )}

              {isSelected && commit.task_id && (
                <text
                  x={x + 67}
                  y={y + 34}
                  textAnchor="middle"
                  className="fill-muted-foreground pointer-events-none select-none"
                  style={{ fontSize: '10px' }}
                >
                  {commit.task_id.substring(0, 8)}
                </text>
              )}

              {isSelected && (
                <text
                  x={x + 35}
                  y={y + 55}
                  textAnchor="start"
                  className="fill-muted-foreground pointer-events-none select-none"
                  style={{ fontSize: '9px' }}
                >
                  {commit.author} • {formatDate(commit.date, {
                    day: 'numeric',
                    month: 'short',
                  })}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="absolute bottom-4 left-4 bg-card border border-border rounded-lg p-3">
        <div className="text-xs font-medium text-foreground mb-2">{t('git.legend', 'Legend')}</div>
        <div className="flex gap-4">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-emerald-500" />
            <span className="text-xs text-muted-foreground">{t('git.done', 'Done')}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-primary" />
            <span className="text-xs text-muted-foreground">{t('git.planned', 'Planned')}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-amber-500 animate-pulse-slow" />
            <span className="text-xs text-muted-foreground">{t('git.inProgress', 'In progress')}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
