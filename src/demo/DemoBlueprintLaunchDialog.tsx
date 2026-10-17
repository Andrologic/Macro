import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgsdlTranslation } from '../components/agsdl/useAgsdlTranslation';
import { LayoutTemplate, X, Play, ChevronRight, FolderGit2, Search } from 'lucide-react';
import { Dialog } from '../components/ui/Dialog';
import { Button } from '../components/ui/Button';
import type { TaskProjectFilterOption } from '../components/tasks/TaskProjectFilter';
import { missingBlueprintFields, type DemoBlueprint, type DemoBlueprintUse } from './blueprintLaunch';
import { launchDemoBlueprint } from './blueprintLaunchService';
import { createDemoWorkflowDraftWriter } from './blueprintDraft';
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
  const [draftWriter] = useState(() => createDemoWorkflowDraftWriter());
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
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
    setUseId(undefined); setError(''); setProjectQuery('');
  };
  const missing = blueprint ? missingBlueprintFields(blueprint, values) : [];
  const fieldsToComplete = blueprint?.fields.filter(field => !field.value.trim() || !(values[field.id] ?? field.value).trim()) ?? [];
  const choose = (item: DemoBlueprint) => {
    setObjective(item.title); setBlueprintId(item.id); setValues(Object.fromEntries(item.fields.map(field => [field.id, field.value]))); setUseId(crypto.randomUUID()); setError('');
  };
  useEffect(() => {
    if (!useId || !blueprintId || !projectId || busy) return;
    let current = true;
    void draftWriter.save({ id: useId, blueprintId, projectId, objective, values }).then(saved => {
      if (current) {
        setPrepared(items => [...items.filter(item => item.id !== saved.id), saved]);
        setError('');
      }
    }).catch(error => { if (current) setError(String(error)); });
    return () => { current = false; };
  }, [draftWriter, useId, blueprintId, projectId, objective, values, busy]);
  useEffect(() => {
    if (!projectId || blueprintId) return;
    let current = true;
    void draftWriter.flush().then(() => invoke<DemoBlueprintUse[]>('demo_blueprint_uses')).then(uses => {
      if (current) setPrepared(uses.filter(use => use.state === 'prepared'));
    }).catch(error => { if (current) setError(String(error)); });
    return () => { current = false; };
  }, [projectId, blueprintId, draftWriter]);
  const persistDraft = () => useId && blueprint
    ? draftWriter.save({ id: useId, blueprintId, projectId, objective, values })
    : draftWriter.flush();
  const close = async () => {
    if (busy) return;
    setBusy(true);
    try { await persistDraft(); onClose(); }
    catch (error) { setError(String(error)); setBusy(false); }
  };
  const launch = async () => {
    if (busy || !blueprint) return;
    setBusy(true); setError('');
    try {
      const use = await persistDraft();
      if (!use) return;
      await launchDemoBlueprint(use.id);
      onClose();
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  return <Dialog title={t('agsdl.demoLaunch.title')} onClose={() => void close()} closeOnBackdropClick panelClassName="agsdl-detail-modal demo-launch-modal">
    <header>
      <div><Play size={17} /><strong>{t('agsdl.demoLaunch.title')}</strong></div>
      <button className="agsdl-icon-button" disabled={busy} onClick={() => void close()} aria-label={t('agsdl.close')}><X size={17} /></button>
    </header>
    <div className="demo-launch-body">
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      {!loaded && !error && <p role="status">{t('agsdl.loading')}</p>}
      {!project ? <section className="demo-launch-projects">
        <h3>{t('agsdl.demoLaunch.chooseProject')}</h3>
        <label className="demo-launch-search">
          <Search size={15} />
          <input aria-label={t('agsdl.demoLaunch.searchProject')} placeholder={t('agsdl.demoLaunch.searchProject')} value={projectQuery} onChange={event => setProjectQuery(event.target.value)} />
        </label>
        <div className="demo-launch-project-list">
          {visibleProjects.map(item => <button key={item.id} disabled={!loaded} onClick={() => setProjectId(item.id)}>
            <FolderGit2 size={20} /><span><strong>{item.name}</strong></span><ChevronRight size={16} />
          </button>)}
          {visibleProjects.length === 0 && <p className="demo-journey-muted">{t('agsdl.demoLaunch.noProjects')}</p>}
        </div>
      </section> : <>
        <div className="demo-launch-project-selected">
          <FolderGit2 size={18} /><strong>{project.name}</strong>
          <button disabled={busy} onClick={changeProject}>{t('agsdl.demoLaunch.change')}</button>
        </div>
        {!blueprint && projectPreparations.length > 0 && <section className="demo-launch-prepared">
          <h3>{t('agsdl.demoLaunch.prepared')}</h3>
          {projectPreparations.map(use => <button key={use.id} onClick={() => { setBlueprintId(use.blueprint.id); setValues(use.values); setObjective(use.objective); setUseId(use.id); }}>
            <LayoutTemplate size={15} /><span>{use.objective || use.blueprint.title}{use.objective && use.objective !== use.blueprint.title && <small>{use.blueprint.title}</small>}</span><ChevronRight size={15} />
          </button>)}
        </section>}
        {blueprint ? <div className="demo-launch-blueprint-selected">
          <LayoutTemplate size={18} /><strong>{blueprint.title}</strong>
          <button disabled={busy} onClick={() => { setBlueprintId(''); setUseId(undefined); }}>{t('agsdl.demoLaunch.change')}</button>
        </div> : <section>
          <div className="demo-launch-section-title"><h3>{t('agsdl.demoLaunch.blueprint')}</h3></div>
          <div className="demo-launch-catalog">
            {projectBlueprints.map(item => <button key={item.id} onClick={() => choose(item)}>
              <LayoutTemplate size={18} /><span><strong>{item.title}</strong></span><ChevronRight size={16} />
            </button>)}
            {loaded && projectBlueprints.length === 0 && <p className="demo-journey-muted">{t('agsdl.demoLaunch.noBlueprints')}</p>}
          </div>
        </section>}
      </>}
      {blueprint && fieldsToComplete.length > 0 && <div className="demo-launch-inputs">
        {fieldsToComplete.map(field => <label key={field.id}>
          <span>{field.label}</span>
          {field.id.toLowerCase().includes('model') ? <select disabled={busy} value={values[field.id] ?? ''} onChange={event => setValues({ ...values, [field.id]: event.target.value })}>
            <option value="">{t('agsdl.demoLaunch.chooseModel')}</option>
            {[...new Set([field.value, 'Macro AI · Démo', 'Macro AI · Équilibré', 'Macro AI · Rapide'].filter(Boolean))].map(value => <option key={value} value={value}>{value}</option>)}
          </select> : <input disabled={busy} value={values[field.id] ?? ''} onChange={event => setValues({ ...values, [field.id]: event.target.value })} />}
        </label>)}
      </div>}
    </div>
    {blueprint && <footer>
      <Button disabled={!projectId || missing.length > 0 || busy} onClick={() => void launch()}><Play size={14} />{t('agsdl.demoLaunch.launch')}</Button>
    </footer>}
  </Dialog>;
}
