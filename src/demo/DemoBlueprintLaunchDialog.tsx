import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgsdlTranslation } from '../components/agsdl/useAgsdlTranslation';
import { LayoutTemplate, X, Play, Check, Circle, Bot, ChevronRight } from 'lucide-react';
import { Dialog } from '../components/ui/Dialog';
import { Button } from '../components/ui/Button';
import type { TaskProjectFilterOption } from '../components/tasks/TaskProjectFilter';
import { useAppStore } from '../stores/useAppStore';
import { missingBlueprintFields, type DemoBlueprint, type DemoBlueprintUse } from './blueprintLaunch';
import { launchDemoBlueprint } from './blueprintLaunchService';
import './blueprintJourney.css';

export default function DemoBlueprintLaunchDialog({ projects, onClose }: { projects: TaskProjectFilterOption[]; onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const selectedProject = useAppStore(state => state.selectedProjectId);
  const [projectId, setProjectId] = useState(projects.find(project => project.id === selectedProject)?.id ?? projects[0]?.id ?? '');
  const [catalog, setCatalog] = useState<DemoBlueprint[]>([]);
  const [prepared, setPrepared] = useState<DemoBlueprintUse[]>([]);
  const [blueprintId, setBlueprintId] = useState('');
  const [objective, setObjective] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [useId, setUseId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [environment, setEnvironment] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([invoke<DemoBlueprint[]>('demo_blueprint_catalog'), invoke<DemoBlueprintUse[]>('demo_blueprint_uses')]).then(([items, uses]) => {
      if (active) { setCatalog(items); setPrepared(uses.filter(use => use.state === 'prepared')); setLoaded(true); }
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, []);
  const blueprint = catalog.find(item => item.id === blueprintId);
  const missing = blueprint ? missingBlueprintFields(blueprint, objective, values) : [];
  const choose = (item: DemoBlueprint) => {
    setBlueprintId(item.id); setValues(Object.fromEntries(item.fields.map(field => [field.id, field.value]))); setUseId(undefined); setError('');
  };
  const save = async (launch: boolean) => {
    if (busy || !blueprint) return;
    setBusy(true); setError('');
    try {
      const use = await invoke<DemoBlueprintUse>('demo_blueprint_prepare', { id: useId, blueprintId, projectId, objective, values });
      setUseId(use.id);
      if (launch) await launchDemoBlueprint(use.id);
      onClose();
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  return <Dialog title={t('agsdl.demoLaunch.title')} onClose={() => { if (!busy) onClose(); }} closeOnBackdropClick panelClassName="agsdl-detail-modal demo-launch-modal">
    <header><div><LayoutTemplate size={17} /><strong>{t('agsdl.demoLaunch.title')}</strong></div><button className="agsdl-icon-button" disabled={busy} onClick={onClose} aria-label={t('agsdl.close')}><X size={17} /></button></header>
    <div className="demo-launch-body">
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      {!loaded && !error && <p role="status">{t('agsdl.loading')}</p>}
      <label className="demo-launch-field"><span>{t('agsdl.demoLaunch.project')}</span><select disabled={busy} value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {!blueprint && prepared.length > 0 && <section className="demo-launch-prepared"><h3>{t('agsdl.demoLaunch.prepared')}</h3>{prepared.map(use => <button key={use.id} onClick={() => { setBlueprintId(use.blueprint.id); setProjectId(use.projectId); setValues(use.values); setObjective(use.objective); setUseId(use.id); }}><LayoutTemplate size={15} /><span>{use.objective || use.blueprint.title}<small>{use.blueprint.title}</small></span><ChevronRight size={15} /></button>)}</section>}
      <section><div className="demo-launch-section-title"><h3>{t('agsdl.demoLaunch.blueprint')}</h3>{blueprint && <button disabled={busy} onClick={() => { setBlueprintId(''); setUseId(undefined); }}>{t('agsdl.demoLaunch.change')}</button>}</div>
        {blueprint ? <div className="demo-launch-selected"><LayoutTemplate size={19} /><span><strong>{blueprint.title}</strong><small>{blueprint.description}</small></span><Check size={16} /></div> : <div className="demo-launch-catalog">{catalog.map(item => <button key={item.id} onClick={() => choose(item)}><LayoutTemplate size={19} /><span><strong>{item.title}</strong><small>{item.description}</small><em><Bot size={12} />{item.agents.length} {t('agsdl.demoLaunch.agents')}</em></span><ChevronRight size={16} /></button>)}</div>}
      </section>
      {blueprint && <>
        <label className="demo-launch-field"><span>{t('agsdl.demoLaunch.objective')}</span><textarea disabled={busy} rows={2} value={objective} placeholder={t('agsdl.demoLaunch.objectiveHint')} onChange={event => setObjective(event.target.value)} /></label>
        <section><div className="demo-launch-section-title"><h3>{t('agsdl.demoLaunch.inputs')}</h3><span className="demo-launch-count">{blueprint.fields.length - missing.filter(id => id !== 'objective').length}/{blueprint.fields.length}</span></div>
          <div className="demo-launch-inputs">{blueprint.fields.map(field => <label key={field.id}><span>{(values[field.id] ?? '').trim() ? <Check size={14} className="text-emerald-400" /> : <Circle size={13} className="text-muted-foreground" />}{field.label}</span>{field.id.toLowerCase().includes('model') ? <select disabled={busy} value={values[field.id] ?? ''} onChange={event => setValues({ ...values, [field.id]: event.target.value })}><option value="">{t('agsdl.demoLaunch.chooseModel')}</option>{[...new Set([field.value, 'Macro AI · Démo', 'Macro AI · Équilibré', 'Macro AI · Rapide'].filter(Boolean))].map(value => <option key={value} value={value}>{value}</option>)}</select> : <input disabled={busy} value={values[field.id] ?? ''} placeholder={field.label} onChange={event => setValues({ ...values, [field.id]: event.target.value })} />}</label>)}</div>
        </section>
        <section className="demo-launch-environment"><button aria-expanded={environment} onClick={() => setEnvironment(!environment)}><ChevronRight size={14} className={environment ? 'rotate-90' : ''} />{t('agsdl.demoLaunch.environment')}</button>{environment && <p>{t('agsdl.demoLaunch.simulation')}</p>}</section>
      </>}
    </div>
    <footer><span className="demo-launch-hint">{blueprint && t(missing.length ? 'agsdl.demoLaunch.incomplete' : 'agsdl.demoLaunch.ready')}</span><Button variant="secondary" disabled={!blueprint || !projectId || busy} onClick={() => void save(false)}>{t('agsdl.demoLaunch.prepare')}</Button><Button disabled={!blueprint || !projectId || missing.length > 0 || busy} onClick={() => void save(true)}><Play size={14} />{t('agsdl.demoLaunch.launch')}</Button></footer>
  </Dialog>;
}
