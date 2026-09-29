import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { Dialog } from '../ui/Dialog';
import { DiffMergeView } from '../ui/DiffMergeView';
import { listConversationGoalAuditArtifacts, readGoalAuditArtifact, type GoalAuditArtifact } from '../../composition/goalArtifactComposition';

interface Props { projectId: string; conversationId: string; goalId?: string | null; refreshKey: number }

export const GoalAuditArtifactsButton: React.FC<Props> = ({ projectId, conversationId, goalId, refreshKey }) => {
  const { t } = useTranslation();
  const [artifacts, setArtifacts] = useState<GoalAuditArtifact[]>([]);
  const [selected, setSelected] = useState<GoalAuditArtifact | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState('');
  const [indexError, setIndexError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setArtifacts([]); setSelected(null); setContent(''); setIndexError(null); setContentError(null); setIsOpen(false);
  }, [projectId, conversationId, goalId]);

  useEffect(() => {
    let active = true;
    void listConversationGoalAuditArtifacts(projectId, conversationId, goalId).then((items) => {
      if (active) { setArtifacts(items); setIndexError(null); }
    }).catch((cause) => {
      if (active) { setArtifacts([]); setIndexError(cause instanceof Error ? cause.message : String(cause)); }
    });
    return () => { active = false; };
  }, [projectId, conversationId, goalId, refreshKey, retryKey]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    setContent(''); setContentError(null);
    void readGoalAuditArtifact(selected).then((value) => { if (active) { setContent(value); setContentError(null); } })
      .catch((cause) => { if (active) setContentError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [selected, retryKey]);

  const error = contentError ?? indexError;
  if (!artifacts.length && !indexError) return null;
  return <>
    <button type="button" className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-accent" onClick={() => { setSelected(artifacts.at(-1) ?? null); setIsOpen(true); }}>
      <Icon name="file-text" size={14} />
      {t('goal.artifacts', 'Goal reviews')} {artifacts.length}
    </button>
    {isOpen && <Dialog title={t('goal.artifacts', 'Goal reviews')} onClose={() => setIsOpen(false)} panelClassName="flex h-full w-full max-w-5xl justify-center">
      <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3 text-sm font-medium">
          <span>{t('goal.artifacts', 'Goal reviews')}</span>
          <button type="button" onClick={() => setIsOpen(false)} aria-label={t('common.close', 'Close')}><Icon name="x" size={16} /></button>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav className="w-52 shrink-0 overflow-y-auto border-r border-border p-2">
            {artifacts.map((artifact) => <button key={artifact.id} type="button" className="block w-full rounded px-2 py-2 text-left text-xs hover:bg-accent" onClick={() => { setSelected(artifact); setContent(''); }}>
              {t('goal.artifactTitle', 'Goal review')} · {t(`goal.artifactStatus.${artifact.review.verdict ?? artifact.review.status}`, artifact.review.verdict ?? artifact.review.status)}
            </button>)}
          </nav>
          <div className="min-w-0 flex-1">
            {error ? <div className="p-4 text-xs text-destructive"><p role="alert">{error}</p><button type="button" className="mt-2 rounded border border-border px-2 py-1" onClick={() => setRetryKey((value) => value + 1)}>{t('common.retry', 'Retry')}</button></div> : <DiffMergeView original="" modified={content} language="javascript" layout="right-only" presentationMode="full" className="h-full w-full border-none" editable={false} />}
          </div>
        </div>
      </div>
    </Dialog>}
  </>;
};
