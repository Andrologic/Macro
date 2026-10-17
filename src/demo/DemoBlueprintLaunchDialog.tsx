import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgsdlTranslation } from '../components/agsdl/useAgsdlTranslation';
import { LayoutTemplate, X, Play, Check, Circle, Bot, ChevronRight, FolderGit2, Search } from 'lucide-react';
import { Dialog } from '../components/ui/Dialog';
import { Button } from '../components/ui/Button';
import type { TaskProjectFilterOption } from '../components/tasks/TaskProjectFilter';
import { missingBlueprintFields, type DemoBlueprint, type DemoBlueprintUse } from './blueprintLaunch';
import { launchDemoBlueprint } from './blueprintLaunchService';
import './blueprintJourney.css';

export default function DemoBlueprintLaunchDialog({ projects, onClose }: { projects: TaskProjectFilterOption[]; onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const [projectId, setProjectId] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
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
  const project = projects.find(item => item.id === projectId);
  const projectBlueprints = catalog.filter(item => item.projectIds.includes(projectId));
  const projectPreparations = prepared.filter(use => use.projectId === projectId);
  const blueprint = projectBlueprints.find(item => item.id === blueprintId);
  const visibleProjects = projects.filter(item => item.name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase().includes(projectQuery.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase()));
  const changeProject = () => {
    setProjectId(''); setBlueprintId(''); setObjective(''); setValues({});
    setUseId(undefined); setError(''); setEnvironment(false); setProjectQuery('');
  };
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
      {!project ? <section className="demo-launch-projects">
        <h3>{t('agsdl.demoLaunch.chooseProject')}</h3>
        <label className="demo-launch-search"><Search size={15} /><input aria-label={t('agsdl.demoLaunch.searchProject')} placeholder={t('agsdl.demoLaunch.searchProject')} value={projectQuery} onChange={event => setProjectQuery(event.target.value)} /></label>
        <div className="demo-launch-project-list">
          {visibleProjects.map(item => <button key={item.id} disabled={!loaded} onClick={() => setProjectId(item.id)}>
            <FolderGit2 size={20} /><span><strong>{item.name}</strong><small>{t('agsdl.demoLaunch.blueprintCount', { count: catalog.filter(blueprint => blueprint.projectIds.includes(item.id)).length })}</small></span><ChevronRight size={16} />
          </button>)}
          {visibleProjects.length === 0 && <p className="demo-journey-muted">{t('agsdl.demoLaunch.noProjects')}</p>}
        </div>
      </section> : <>
        <div className="demo-launch-project-selected"><FolderGit2 size={18} /><strong>{project.name}</strong><button disabled={busy} onClick={changeProject}>{t('agsdl.demoLaunch.change')}</button></div>
        {!blueprint && projectPreparations.length > 0 && <section className="demo-launch-prepared"><h3>{t('agsdl.demoLaunch.prepared')}</h3>{projectPreparations.map(use => <button key={use.id} onClick={() => { setBlueprintId(use.blueprint.id); setValues(use.values); setObjective(use.objective); setUseId(use.id); }}><LayoutTemplate size={15} /><span>{use.objective || use.blueprint.title}<small>{use.blueprint.title}</small></span><ChevronRight size={15} /></button>)}</section>}
        <section><div className="demo-launch-section-title"><h3>{t('agsdl.demoLaunch.blueprint')}</h3>{blueprint && <button disabled={busy} onClick={() => { setBlueprintId(''); setUseId(undefined); }}>{t('agsdl.demoLaunch.change')}</button>}</div>
          {blueprint ? <div className="demo-launch-selected"><LayoutTemplate size={19} /><span><strong>{blueprint.title}</strong><small>{blueprint.description}</small></span><Check size={16} /></div> : <div className="demo-launch-catalog">{projectBlueprints.map(item => <button key={item.id} onClick={() => choose(item)}><LayoutTemplate size={19} /><span><strong>{item.title}</strong><small>{item.description}</small><em><Bot size={12} />{item.agents.length} {t('agsdl.demoLaunch.agents')}</em></span><ChevronRight size={16} /></button>)}{loaded && projectBlueprints.length === 0 && <p className="demo-journey-muted">{t('agsdl.demoLaunch.noBlueprints')}</p>}</div>}
        </section>
      </>}
      {blueprint && <>
        <label className="demo-launch-field"><span>{t('agsdl.demoLaunch.objective')}</span><textarea disabled={busy} rows={2} value={objective} placeholder={t('agsdl.demoLaunch.objectiveHint')} onChange={event => setObjective(event.target.value)} /></label>
        <section><div className="demo-launch-section-title"><h3>{t('agsdl.demoLaunch.inputs')}</h3><span className="demo-launch-count">{blueprint.fields.length - missing.filter(id => id !== 'objective').length}/{blueprint.fields.length}</span></div>
          <div className="demo-launch-inputs">{blueprint.fields.map(field => <label key={field.id}><span>{(values[field.id] ?? '').trim() ? <Check size={14} className="text-emerald-400" /> : <Circle size={13} className="text-muted-foreground" />}{field.label}</span>{field.id.toLowerCase().includes('model') ? <select disabled={busy} value={values[field.id] ?? ''} onChange={event => setValues({ ...values, [field.id]: event.target.value })}><option value="">{t('agsdl.demoLaunch.chooseModel')}</option>{[...new Set([field.value, 'Macro AI · Démo', 'Macro AI · Équilibré', 'Macro AI · Rapide'].filter(Boolean))].map(value => <option key={value} value={value}>{value}</option>)}</select> : <input disabled={busy} value={values[field.id] ?? ''} placeholder={field.label} onChange={event => setValues({ ...values, [field.id]: event.target.value })} />}</label>)}</div>
        </section>
        <section className="demo-launch-environment"><button aria-expanded={environment} onClick={() => setEnvironment(!environment)}><ChevronRight size={14} className={environment ? 'rotate-90' : ''} />{t('agsdl.demoLaunch.environment')}</button>{environment && <p>{t('agsdl.demoLaunch.simulation')}</p>}</section>
      </>}
    </div>
    <footer>
      <span className="demo-launch-hint">{blueprint && t(missing.length ? 'agsdl.demoLaunch.incomplete' : 'agsdl.demoLaunch.ready')}</span>
      {blueprint ? <>
        <Button variant="secondary" disabled={!projectId || busy} onClick={() => void save(false)}>{t('agsdl.demoLaunch.prepare')}</Button>
        <Button disabled={!projectId || missing.length > 0 || busy} onClick={() => void save(true)}><Play size={14} />{t('agsdl.demoLaunch.launch')}</Button>
      </> : <Button variant="secondary" onClick={onClose}>{t('agsdl.close')}</Button>}
    </footer>
  </Dialog>;
}
