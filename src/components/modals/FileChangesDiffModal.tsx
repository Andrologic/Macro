import React, { useMemo } from 'react';
import { useFileChangesStore } from '../../stores/useFileChangesStore';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';

interface FileChangesDiffModalProps {
  changeId: string;
  onClose: () => void;
}

// Simple diff visualization - highlight added/removed lines
function computeDiffLines(
  original: string,
  modified: string
): { type: 'unchanged' | 'added' | 'removed'; content: string; lineNum: number | null }[] {
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');
  const result: { type: 'unchanged' | 'added' | 'removed'; content: string; lineNum: number | null }[] = [];

  // Simple LCS-based diff for demo purposes
  let i = 0;
  let j = 0;
  let lineNum = 1;

  while (i < originalLines.length || j < modifiedLines.length) {
    if (i >= originalLines.length) {
      // Remaining are additions
      result.push({ type: 'added', content: modifiedLines[j], lineNum: lineNum++ });
      j++;
    } else if (j >= modifiedLines.length) {
      // Remaining are deletions
      result.push({ type: 'removed', content: originalLines[i], lineNum: null });
      i++;
    } else if (originalLines[i] === modifiedLines[j]) {
      result.push({ type: 'unchanged', content: originalLines[i], lineNum: lineNum++ });
      i++;
      j++;
    } else {
      // Check if original line was removed
      const foundInModified = modifiedLines.slice(j).indexOf(originalLines[i]);
      const foundInOriginal = originalLines.slice(i).indexOf(modifiedLines[j]);

      if (foundInOriginal !== -1 && (foundInModified === -1 || foundInOriginal <= foundInModified)) {
        // Current modified line is new
        result.push({ type: 'added', content: modifiedLines[j], lineNum: lineNum++ });
        j++;
      } else {
        // Current original line was removed
        result.push({ type: 'removed', content: originalLines[i], lineNum: null });
        i++;
      }
    }
  }

  return result;
}

export const FileChangesDiffModal: React.FC<FileChangesDiffModalProps> = ({ changeId, onClose }) => {
  const { getChange, markAsReviewed } = useFileChangesStore();
  const change = getChange(changeId);

  const diffLines = useMemo(() => {
    if (!change) return [];
    return computeDiffLines(change.originalContent, change.modifiedContent);
  }, [change]);

  if (!change) return null;

  const handleMarkReviewed = () => {
    markAsReviewed(changeId);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-5xl max-h-[90vh] bg-card border border-border shadow-2xl rounded-xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/20 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={cn(
                'w-8 h-8 rounded-lg flex items-center justify-center',
                change.status === 'added'
                  ? 'bg-emerald-500/10'
                  : change.status === 'modified'
                  ? 'bg-amber-500/10'
                  : 'bg-red-500/10'
              )}
            >
              <Icon
                name={
                  change.status === 'added' ? 'plus' : change.status === 'modified' ? 'edit' : 'trash'
                }
                size={16}
                className={
                  change.status === 'added'
                    ? 'text-emerald-500'
                    : change.status === 'modified'
                    ? 'text-amber-500'
                    : 'text-red-500'
                }
              />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground truncate">{change.path}</h2>
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                <span className="text-emerald-500">+{change.additions}</span>
                <span className="text-red-400">-{change.deletions}</span>
                <span className="capitalize">{change.status}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {change.reviewed && (
              <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-500/10 text-emerald-500 text-xs">
                <Icon name="check" size={12} />
                Reviewed
              </span>
            )}
            <button onClick={onClose} className="p-2 hover:bg-accent rounded-full transition-colors">
              <Icon name="x" size={18} className="text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* Diff Content */}
        <div className="flex-1 overflow-auto">
          <div className="font-mono text-xs leading-relaxed">
            {diffLines.map((line, idx) => (
              <div
                key={idx}
                className={cn(
                  'flex border-b border-border/30',
                  line.type === 'added'
                    ? 'bg-emerald-500/5'
                    : line.type === 'removed'
                    ? 'bg-red-500/5'
                    : ''
                )}
              >
                {/* Line number */}
                <div className="w-12 px-2 py-0.5 text-right text-muted-foreground/50 select-none border-r border-border/30 shrink-0">
                  {line.lineNum ?? ''}
                </div>

                {/* Change indicator */}
                <div
                  className={cn(
                    'w-6 px-1 py-0.5 text-center select-none shrink-0',
                    line.type === 'added'
                      ? 'text-emerald-500 bg-emerald-500/10'
                      : line.type === 'removed'
                      ? 'text-red-400 bg-red-500/10'
                      : 'text-transparent'
                  )}
                >
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                </div>

                {/* Code content */}
                <pre
                  className={cn(
                    'flex-1 px-3 py-0.5 whitespace-pre overflow-x-auto',
                    line.type === 'added'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : line.type === 'removed'
                      ? 'text-red-600 dark:text-red-400 line-through opacity-70'
                      : 'text-foreground'
                  )}
                >
                  {line.content || ' '}
                </pre>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-muted/20 shrink-0">
          <div className="text-xs text-muted-foreground">
            {diffLines.filter((l) => l.type === 'added').length} additions,{' '}
            {diffLines.filter((l) => l.type === 'removed').length} deletions
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Close
            </button>
            {!change.reviewed && (
              <button
                onClick={handleMarkReviewed}
                className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2"
              >
                <Icon name="check" size={14} />
                Mark as Reviewed
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
