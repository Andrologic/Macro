import { EyeOff } from 'lucide-react';
import { useMemo } from 'react';
import { projectViewer } from '../../services/agsdl/viewer';
import { projectSystemOverview } from '../../services/agsdl/systemOverview';
import type { NativeCardState } from '../../services/agsdl/executionView';
import { WorkflowGraph } from './WorkflowGraph';
import type { WorkflowOccurrenceBadge030 } from './WorkflowStatusBadge';
import type { RunGraphBridge030 } from './RunInspector030';
import { useAgsdlTranslation } from './useAgsdlTranslation';

export function CapturedRunGraph030({ bridge, currentSource, onInspect, hiddenAgents, onOpenInstance }: {
  bridge: RunGraphBridge030; currentSource?: string; onInspect?: () => void;
  hiddenAgents?: ReadonlySet<string>; onOpenInstance?: (id: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const document = useMemo(() => {
    try { return projectViewer(bridge.capture.authoredSource); } catch { return null; }
  }, [bridge.capture.authoredSource]);
  const graph = document?.graphs[0];
  const system = useMemo(() => projectSystemOverview(graph, document?.declarations ?? []), [graph, document]);
  const cards = useMemo(() => system.cards.map(card => typeof card.details.agentName === 'string' && hiddenAgents?.has(card.details.agentName)
    ? { ...card, hiddenInOperate: true } : card), [system.cards, hiddenAgents]);
  const hiddenInstances = bridge.inspection?.state.instances.filter(instance => hiddenAgents?.has(instance.agent) && !instance.discarded);
  const badges: Record<string, WorkflowOccurrenceBadge030[]> = {};
  const stateFor = (phase: string, stop: boolean): NativeCardState => stop || phase === 'withdrawingSteer' ? 'stopRequested'
    : ['done', 'completed', 'succeeded', 'ended'].includes(phase) ? 'completed'
    : phase === 'failed' ? 'failed' : ['cancelled', 'withdrawn'].includes(phase) ? 'stopped'
    : phase === 'waiting' ? 'approval' : ['running', 'steering', 'live', 'body', 'group', 'barrier'].includes(phase) ? 'active'
    : ['queued', 'ready', 'pending', 'preparing'].includes(phase) ? 'queued' : 'uncertain';
  for (const visit of bridge.occurrences) {
    if (!visit.staticOccurrenceId) continue;
    const activation = visit.occurrence.activation;
    (badges[visit.staticOccurrenceId] ??= []).push({ activationId: visit.activationId,
      state: stateFor(activation.phase, activation.stopRequested), partial: bridge.occurrenceRead.stale || !bridge.occurrenceRead.complete });
  }
  const selected = system.cards.find(card => card.static030?.occurrenceId === bridge.selectedStepId)?.path ?? '';
  return <div className="agsdl-captured-graph" data-captured-run={bridge.capture.systemStartId}>
    {document ? <WorkflowGraph cards={cards} edges={system.edges} entry={system.entry} compositions={document.graphs} declarations={document.declarations}
      source={bridge.capture.authoredSource} selected={selected} occurrenceBadges={badges} title={card => card.title || t('agsdl.viewer.unnamed')}
      select={path => {
        const card = system.cards.find(card => card.path === path);
        bridge.selectStep(card?.static030?.occurrenceId);
        const visits = bridge.occurrences.filter(visit => visit.staticOccurrenceId === card?.static030?.occurrenceId);
        if (visits.length) bridge.selectOccurrence(visits.at(-1)!.key);
        if (path) onInspect?.();
      }} /> : <p role="status">{t('agsdl.viewer.unreadable')}</p>}
    {!!hiddenInstances?.length && onOpenInstance && <details className="absolute bottom-8 left-2 z-10 rounded border border-border bg-background px-2 py-1 text-xs">
      <summary className="cursor-pointer">{t('agsdl.inbox.chipHidden')}</summary>
      <ul className="max-h-48 overflow-auto">{hiddenInstances.map(instance => <li key={instance.id}>
        <button type="button" className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent" onClick={() => onOpenInstance(instance.id)}>
          <EyeOff size={11} aria-hidden="true" />{instance.agent}{instance.selectorName && ` · ${instance.selectorName}`}
        </button>
      </li>)}</ul>
    </details>}
    <span className="agsdl-capture-label" role="status">{t(currentSource !== undefined && currentSource !== bridge.capture.authoredSource ? 'agsdl.canvas030.capturedDifferent' : 'agsdl.canvas030.captured')}
      {' · '}{t('agsdl.run030.sourceRevision')} {bridge.capture.source.revision}
      {bridge.occurrenceRead.stale && ` · ${t('agsdl.run030.staleShort')}`}</span>
  </div>;
}
