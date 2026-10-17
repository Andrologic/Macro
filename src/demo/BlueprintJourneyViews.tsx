import { useState } from 'react';
import { LayoutTemplate, Settings2, Bot, Package, Plug, Tag, X } from 'lucide-react';
import ArchitectStrategyPanel from '../components/architect/ArchitectStrategyPanel';
import { Dialog } from '../components/ui/Dialog';
import { useAgsdlTranslation } from '../components/agsdl/useAgsdlTranslation';
import { agsdlErrorText } from '../components/agsdl/errorText';
import { useAppStore } from '../stores/useAppStore';
import { agsdlSessionKey, useAgsdlStore } from '../stores/useAgsdlStore';
import { defaultLaunchRequirements, sampleLaunchValues, launchFields, releaseTarget } from './blueprintInputs';
import './blueprintJourney.css';

const fieldIcons = { tag: Tag, package: Package, bot: Bot, plug: Plug };
export function DemoArchitectPanel() {
  const { t } = useAgsdlTranslation();
  const active = useAppStore(state => state.activeArchitectPlanId);
  const ready = useAgsdlStore(state => !!state.sessions[agsdlSessionKey(releaseTarget)]);
  const [open, setOpen] = useState(false);
  return <div className="demo-journey-architect">
    {active === releaseTarget.planId && <div className="demo-journey-entry"><LayoutTemplate size={16} /><div><strong>{t('agsdl.journey.blueprint')}</strong><button disabled={!ready} onClick={() => setOpen(true)}><Settings2 size={13} />{t('agsdl.journey.prepare')}</button></div></div>}
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
    <footer><button disabled={busy} onClick={onClose}>{t('agsdl.close')}</button></footer>
  </Dialog>;
}
