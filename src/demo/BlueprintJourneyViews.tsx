import { useMemo, useState } from 'react';
import { ArrowRight, Bot, Check, Circle, LayoutTemplate, Package, PencilRuler, Play, Plug, Settings2, Square, Tag, X } from 'lucide-react';
import ArchitectStrategyPanel from '../components/architect/ArchitectStrategyPanel';
import { Dialog } from '../components/ui/Dialog';
import { AgentDetails } from '../components/agsdl/AgentDetails';
import { ComponentDetailsDialog } from '../components/agsdl/ComponentDetailsDialog';
import { projectSystemOverview } from '../services/agsdl/systemOverview';
import { WorkflowGraph } from '../components/agsdl/WorkflowGraph';
import { useAgsdlTranslation } from '../components/agsdl/useAgsdlTranslation';
import { agsdlErrorText } from '../components/agsdl/errorText';
import { useAppStore } from '../stores/useAppStore';
import { agsdlSessionKey, useAgsdlStore } from '../stores/useAgsdlStore';
import { projectViewer } from '../services/agsdl/viewer';
import { defaultLaunchRequirements, sampleLaunchValues, launchFields, missingLaunchFields, releaseBlueprint, releaseTarget, useBlueprintJourney } from './blueprintJourney';
import './blueprintJourney.css';

const fieldIcons = { tag: Tag, package: Package, bot: Bot, plug: Plug };
const toOperate = () => { useBlueprintJourney.getState().prepare(); useAppStore.getState().setMode('Implement'); };
const toArchitect = () => {
  const app = useAppStore.getState();
  app.setMode('Architect', { ensureAutoPlan: false });
  void app.activateArchitectPlan(releaseTarget.planId, { targetBranch: releaseTarget.branchName, allowScopeSwitch: true });
};
export function DemoArchitectPanel() {
  const { t } = useAgsdlTranslation();
  const active = useAppStore(state => state.activeArchitectPlanId);
  const ready = useAgsdlStore(state => !!state.sessions[agsdlSessionKey(releaseTarget)]);
  const [open, setOpen] = useState(false);
  return <div className="demo-journey-architect">
    {active === releaseTarget.planId && <div className="demo-journey-entry"><LayoutTemplate size={16} /><div><strong>{t('agsdl.journey.blueprint')}</strong><button disabled={!ready} onClick={() => setOpen(true)}><Settings2 size={13} />{t('agsdl.journey.prepare')}</button></div><button className="agsdl-icon-button" title={t('agsdl.journey.use')} aria-label={t('agsdl.journey.use')} disabled={!ready} onClick={toOperate}><ArrowRight size={16} /></button></div>}
    <div className="demo-journey-graph"><ArchitectStrategyPanel /></div>
    {open && <BlueprintPreparationDialog onClose={() => setOpen(false)} />}
  </div>;
}
function BlueprintPreparationDialog({ onClose }: { onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(releaseTarget)]);
  const [version, setVersion] = useState(session.version);
  const [requirements, setRequirements] = useState(() => defaultLaunchRequirements().map(item => structuredClone(session.design?.requirements.find(existing => existing.id === item.id) ?? item)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);
  const save = async (choices = requirements) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const store = useAgsdlStore.getState();
      if (!applied) {
        const design = { ...session.design!, kind: 'blueprint' as const, requirements: [...(session.design?.requirements.filter(item => !launchFields.some(field => field.id === item.id)) ?? []), ...choices] };
        store.setDesign(releaseTarget, design, version);
        setVersion(useAgsdlStore.getState().sessions[agsdlSessionKey(releaseTarget)].version); setApplied(true);
      }
      await store.save(releaseTarget);
      setApplied(false);
    } catch (error) { setError(agsdlErrorText(error, t)); }
    finally { setBusy(false); }
  };
  return <Dialog title={t('agsdl.journey.prepare')} onClose={() => { if (!busy) onClose(); }} closeOnBackdropClick panelClassName="agsdl-detail-modal demo-journey-modal">
    <header><strong>{t('agsdl.journey.prepare')}</strong><button disabled={busy} className="agsdl-icon-button" onClick={onClose} aria-label={t('agsdl.close')}><X size={16} /></button></header>
    <div className="agsdl-inspector-body"><p className="demo-journey-muted">{t('agsdl.journey.prepareHint')}</p>
      {launchFields.map(field => { const Icon = fieldIcons[field.icon]; const requirement = requirements.find(item => item.id === field.id); return <label className="demo-journey-rule" key={field.id}><Icon size={17} /><span><strong>{field.label}</strong><small>{field.description}</small></span>
        <select disabled={busy || applied} aria-label={field.label} value={requirement?.value ?? ''} onChange={event => { const next = requirements.map(item => item.id === field.id ? { ...item, value: event.target.value } : item); setRequirements(next); void save(next); }}>
          <option value="">{t('agsdl.journey.atLaunch')}</option>
          <option value={sampleLaunchValues[field.id]}>{sampleLaunchValues[field.id]}</option>
        </select></label>; })}
      <p className="demo-journey-muted" role="status">{t(busy ? 'agsdl.saving' : 'agsdl.journey.savedAutomatically')}</p>{error && <p role="alert">{error}<button className="agsdl-link" disabled={busy} onClick={() => void save()}>{t('agsdl.retry')}</button></p>}
    </div>
    <footer><button disabled={busy} onClick={onClose}>{t('agsdl.close')}</button><button disabled={busy || !!error} className="agsdl-action-button is-primary" onClick={() => { onClose(); toOperate(); }}>{t('agsdl.journey.use')}<ArrowRight size={14} /></button></footer>
  </Dialog>;
}
export function DemoOperateNavigator() {
  const { t } = useAgsdlTranslation();
  const state = useBlueprintJourney();
  return <aside className="demo-operate-nav"><h2>Operate</h2><small>{t('agsdl.journey.blueprints')}</small><button className="demo-operate-blueprint" onClick={toOperate}><LayoutTemplate size={17} /><span>Release mobile<small>Luma Mobile</small></span><Play size={13} /></button>
    <small>{t('agsdl.journey.executions')}</small>{state.runs.length ? state.runs.map(run => <button key={run.id} aria-pressed={state.selected === run.id} onClick={() => state.select(run.id)}><Circle size={12} /><span>Release {run.values.releaseVersion}<small>{t(`agsdl.journey.${run.phase}`)}</small></span></button>) : <p className="demo-journey-muted">{t('agsdl.journey.noRuns')}</p>}
  </aside>;
}
export default function DemoOperateCenter() {
  const { t } = useAgsdlTranslation();
  const state = useBlueprintJourney();
  const run = state.runs.find(item => item.id === state.selected);
  const draft = state.draft;
  const missing = draft ? missingLaunchFields(draft.values) : [];
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  return <main className="demo-operate-center"><header><div><small>Luma Mobile · Blueprint</small><h1>Release mobile</h1></div><button className="agsdl-link" onClick={toArchitect}><PencilRuler size={14} />Architect</button></header>
    <div className="demo-operate-body">
    {run ? <><div className="demo-journey-title"><h2>Release {run.values.releaseVersion}</h2><span className="demo-journey-badge">{t(`agsdl.journey.${run.phase}`)}</span></div><p className="demo-journey-muted">{t('agsdl.journey.simulated')}</p>
      <div className="demo-journey-values">{launchFields.map(field => <div key={field.id}><small>{field.label}</small><span>{run.values[field.id]}</span></div>)}</div>
      {run.instructions && <section className="demo-journey-instructions"><small>{t('agsdl.journey.instructions')}</small><p>{run.instructions}</p></section>}
      <div className="demo-journey-timeline">{['Vérifier les prérequis', 'Relire les changements', 'Vérifier les installateurs'].map((label, index) => <section key={label}><span>{index < run.step ? <Check size={17} /> : <Circle size={17} />}</span><div><strong>{label}</strong><p>{index < run.step ? ['Checklist complétée : version, dépôt et paquets disponibles.', 'Changements relus. Aucun blocage dans les données fictives.', 'Les deux paquets fictifs sont présents et leurs signatures sont conformes.'][index] : index === run.step && run.phase === 'running' ? t('agsdl.journey.running') : t(run.phase === 'stopped' ? 'agsdl.journey.notExecuted' : 'agsdl.journey.waiting')}</p></div></section>)}</div>
      <div className="demo-journey-actions">{run.phase === 'running' ? <button className="agsdl-action-button" onClick={() => state.stop()}><Square size={14} />{t('agsdl.journey.stop')}</button> : <button className="agsdl-action-button" onClick={toOperate}>{t('agsdl.journey.another')}</button>}</div>
    </> : draft ? <><div className="demo-journey-title"><h2>{t('agsdl.journey.prepareRun')}</h2><span className="demo-journey-badge">{missing.length ? t('agsdl.journey.missing', { count: missing.length }) : t('agsdl.journey.ready')}</span></div><p className="demo-journey-muted">{t('agsdl.journey.runHint')}</p>
      <section className="demo-journey-inputs">
        <label><Tag size={18} /><span><strong>Version à vérifier</strong><input placeholder="Ex. 2.4.0" value={draft.values.releaseVersion} onChange={event => state.update('releaseVersion', event.target.value)} /></span></label>
        <label><Package size={18} /><span><strong>Installateurs</strong><select value={draft.values.releasePackages} onChange={event => state.update('releasePackages', event.target.value)}><option value="">{t('agsdl.journey.selectPackages')}</option><option>Luma 2.4 · macOS et Windows</option><option>Luma 2.5 · macOS et Windows</option></select></span></label>
        <label><Bot size={18} /><span><strong>Modèle des agents</strong><select value={draft.values.releaseModel} onChange={event => state.update('releaseModel', event.target.value)}><option value="">{t('agsdl.journey.selectModel')}</option><option>Macro AI · Équilibré</option><option>Macro AI · Rapide</option></select></span></label>
        <div className="demo-journey-connection"><Plug size={18} /><span><strong>Connexion au dépôt</strong><small>{draft.values.releaseRepository || 'GitHub · Luma Mobile · lecture seule'}</small></span><button className="agsdl-action-button" onClick={() => state.update('releaseRepository', draft.values.releaseRepository ? '' : 'GitHub · luma/mobile · lecture seule')}>{t(draft.values.releaseRepository ? 'agsdl.journey.disconnect' : 'agsdl.journey.connect')}</button></div>
      </section>
      <label className="demo-journey-specific"><strong>{t('agsdl.journey.instructions')}</strong><textarea rows={2} placeholder={t('agsdl.journey.optionalHint')} value={draft.instructions} onChange={event => state.instruct(event.target.value)} /></label>
      <button className="agsdl-link" onClick={() => setInstructionsOpen(value => !value)} aria-expanded={instructionsOpen}>{t('agsdl.journey.blueprintInstructions')}</button>
      {instructionsOpen && <div className="demo-journey-instructions">{projectViewer(draft.snapshot.source, draft.snapshot).declarations.filter(card => card.kind === 'Agent').map(card => <p key={card.path}><strong>{card.title}</strong><br />{card.mission}</p>)}</div>}
      <div className="demo-journey-actions"><button className="agsdl-action-button is-primary" disabled={missing.length > 0} onClick={() => state.start()}><Play size={14} />{t('agsdl.journey.start')}</button><small>{t('agsdl.journey.simulated')}</small></div>
    </> : <div className="demo-journey-empty"><LayoutTemplate size={28} /><h2>{t('agsdl.journey.choose')}</h2><button className="agsdl-action-button is-primary" onClick={toOperate}>{t('agsdl.journey.useRelease')}</button></div>}
    </div>
  </main>;
}
export function DemoOperateGraph() {
  const { t } = useAgsdlTranslation();
  const state = useBlueprintJourney();
  const run = state.runs.find(item => item.id === state.selected);
  const snapshot = run?.snapshot ?? state.draft?.snapshot ?? releaseBlueprint();
  const document = useMemo(() => projectViewer(snapshot.source, snapshot), [snapshot]);
  const graph = useMemo(() => projectSystemOverview(document.graphs[0], document.declarations), [document]);
  const [selected, setSelected] = useState('');
  const card = graph.cards.find(card => card.path === selected);
  return <aside className="demo-journey-architect"><header className="demo-operate-graph-title"><LayoutTemplate size={15} /><strong>Release mobile</strong><small>{t(run ? 'agsdl.journey.captured' : 'agsdl.journey.blueprint')}</small></header>
    <div className="demo-journey-graph"><WorkflowGraph cards={graph.cards} edges={graph.edges} selected={selected} select={setSelected} title={card => card.title} trackedTasks={!run ? {} : Object.fromEntries(graph.cards.filter(card => card.kind === 'agent').flatMap((card, index) => run.phase === 'stopped' && index >= run.step ? [] : [[card.path, { taskId: card.id, title: card.title, state: !run ? 'idle_prompt' : index < run.step ? 'completed' : index === run.step && run.phase === 'running' ? 'running' : 'idle_prompt' }]]))} /></div>
    {card && <ComponentDetailsDialog target={releaseTarget} title={card.title} card={card} canEdit={false} onClose={() => setSelected('')}><section className="agsdl-inspector">{card.kind === 'agent' ? <AgentDetails card={card} cards={[...graph.cards, ...document.declarations]} source={snapshot.source} onSelect={setSelected} /> : <p>{card.mission || card.title}</p>}</section></ComponentDetailsDialog>}
  </aside>;
}
