import { useMemo } from 'react';
import { projectViewer } from '../../services/agsdl/viewer';
import { projectSystemOverview } from '../../services/agsdl/systemOverview';
import type { NativeCardState } from '../../services/agsdl/executionView';
import { WorkflowGraph } from './WorkflowGraph';
import type { WorkflowOccurrenceBadge030 } from './WorkflowStatusBadge';
import type { RunGraphBridge030 } from './RunInspector030';
import { useAgsdlTranslation } from './useAgsdlTranslation';

export function CapturedRunGraph030({ bridge, currentSource, onInspect }: { bridge: RunGraphBridge030; currentSource?: string; onInspect?: () => void }) {
  const { t } = useAgsdlTranslation();
  const document = useMemo(() => {
    try { return projectViewer(bridge.capture.authoredSource); } catch { return null; }
  }, [bridge.capture.authoredSource]);
  const graph = document?.graphs[0];
  const system = useMemo(() => projectSystemOverview(graph, document?.declarations ?? []), [graph, document]);
  const badges: Record<string, WorkflowOccurrenceBadge030[]> = {};
  const stateFor = (phase: string, stop: boolean): NativeCardState => stop ? 'stopRequested'
    : ['done', 'completed', 'succeeded', 'ended'].includes(phase) ? 'completed'
    : phase === 'failed' ? 'failed' : ['cancelled', 'withdrawn'].includes(phase) ? 'stopped'
    : phase === 'waiting' ? 'approval' : ['running', 'live', 'body', 'group', 'barrier'].includes(phase) ? 'active'
    : ['queued', 'ready', 'pending', 'preparing'].includes(phase) ? 'queued' : 'uncertain';
  for (const visit of bridge.occurrences) {
    if (!visit.staticOccurrenceId) continue;
    const activation = visit.occurrence.activation;
    (badges[visit.staticOccurrenceId] ??= []).push({ activationId: visit.activationId,
      state: stateFor(activation.phase, activation.stopRequested), partial: bridge.occurrenceRead.stale || !bridge.occurrenceRead.complete });
  }
  const selected = system.cards.find(card => card.static030?.occurrenceId === bridge.selectedStepId)?.path ?? '';
  return <div className="agsdl-captured-graph" data-captured-run={bridge.capture.systemStartId}>
    {document ? <WorkflowGraph cards={system.cards} edges={system.edges} entry={system.entry} compositions={document.graphs} declarations={document.declarations}
      source={bridge.capture.authoredSource} selected={selected} occurrenceBadges={badges} title={card => card.title || t('agsdl.viewer.unnamed')}
      select={path => {
        const card = system.cards.find(card => card.path === path);
        bridge.selectStep(card?.static030?.occurrenceId);
        const visits = bridge.occurrences.filter(visit => visit.staticOccurrenceId === card?.static030?.occurrenceId);
        if (visits.length) bridge.selectOccurrence(visits.at(-1)!.key);
        if (path) onInspect?.();
      }} /> : <p role="status">{t('agsdl.viewer.unreadable')}</p>}
    <span className="agsdl-capture-label" role="status">{t(currentSource !== undefined && currentSource !== bridge.capture.authoredSource ? 'agsdl.canvas030.capturedDifferent' : 'agsdl.canvas030.captured')}
      {' · '}{t('agsdl.run030.sourceRevision')} {bridge.capture.source.revision}
      {bridge.occurrenceRead.stale && ` · ${t('agsdl.run030.staleShort')}`}</span>
  </div>;
}
