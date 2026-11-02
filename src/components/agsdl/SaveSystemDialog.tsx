import { useState } from 'react';
import { Check, Download, LayoutTemplate, Save, X } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { agsdlSessionKey, useAgsdlStore, type AgsdlTarget } from '../../stores/useAgsdlStore';
import { saveBlueprint } from '../../stores/agsdl/blueprints';
import { agsdlExport, downloadAgsdlExport, type AgsdlExportFormat } from '../../services/agsdl/exportDocument';
import { useAgsdlTranslation } from './useAgsdlTranslation';
import { agsdlErrorText } from './errorText';
import './saveSystem.css';

type Destination = 'project' | 'blueprint' | 'export';
export function SaveSystemDialog({ target, title, onClose }: { target: AgsdlTarget; title: string; onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [version] = useState(session.version);
  const demoJourney = import.meta.env.DEV && import.meta.env.VITE_MACRO_DEMO === '1';
  const titleKey = demoJourney ? 'agsdl.persistence.export' : 'agsdl.persistence.title';
  const [destination, setDestination] = useState<Destination>(demoJourney ? 'export' : 'project');
  const [name, setName] = useState(title);
  const [format, setFormat] = useState<AgsdlExportFormat>('source');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const locked = busy || session.saving;
  const act = async () => {
    if (locked) return;
    setBusy(true); setError(''); setDone(false);
    try {
      if (destination === 'project') await useAgsdlStore.getState().save(target);
      else if (destination === 'blueprint') await saveBlueprint(target, name.trim(), undefined, version);
      else {
        const current = useAgsdlStore.getState().sessions[agsdlSessionKey(target)];
        downloadAgsdlExport(agsdlExport(current.source, current.annexes, { design: current.design, display: current.display, migration: current.migration }, name, format));
      }
      setDone(true);
    } catch (error) { setError(agsdlErrorText(error, t)); }
    finally { setBusy(false); }
  };
  const choices = [{ id: 'project', Icon: Save }, { id: 'blueprint', Icon: LayoutTemplate }, { id: 'export', Icon: Download }] as const;
  return <Dialog title={t(titleKey)} onClose={() => { if (!locked) onClose(); }} closeOnBackdropClick panelClassName="agsdl-detail-modal agsdl-save-modal">
    <header><strong>{t(titleKey)}</strong><button className="agsdl-icon-button" disabled={locked} onClick={onClose} aria-label={t('agsdl.close')}><X size={16} /></button></header>
    <div className="agsdl-inspector-body">
      <div className="agsdl-save-destinations" role="group" aria-label={t('agsdl.persistence.destination')}>
        {choices.filter(choice => !demoJourney || choice.id !== 'project').map(({ id, Icon }) => <button key={id} disabled={locked} aria-pressed={destination === id} onClick={() => { setDestination(id); setDone(false); setError(''); }}><Icon size={18} /><span>{t(`agsdl.persistence.${id}`)}</span></button>)}
      </div>
      {destination === 'project' ? <div className="agsdl-save-status"><Check size={18} /><div><strong>{t(session.dirty ? 'agsdl.persistence.pending' : 'agsdl.persistence.saved')}</strong><p>{t('agsdl.persistence.projectHint')}</p></div></div> : <>
        <label className="agsdl-edit-field"><span>{t('agsdl.design.name')}</span><input value={name} maxLength={120} disabled={locked || (done && destination === 'blueprint')} onChange={event => setName(event.target.value)} /></label>
        {destination === 'blueprint' ? <p className="agsdl-muted">{t('agsdl.persistence.blueprintHint')}</p> : <>
          <label className="agsdl-edit-field"><span>{t('agsdl.persistence.format')}</span><select value={format} disabled={locked} onChange={event => { setFormat(event.target.value as AgsdlExportFormat); setDone(false); }}><option value="source">{t('agsdl.persistence.source')}</option><option value="macro">{t('agsdl.persistence.macro')}</option></select></label>
          <p className="agsdl-muted">{t(format === 'source' ? 'agsdl.persistence.sourceHint' : 'agsdl.persistence.macroHint')}</p>
        </>}
      </>}
      {done && <p role="status" className="agsdl-save-result"><Check size={14} />{t(destination === 'export' ? 'agsdl.persistence.downloaded' : 'agsdl.persistence.success')}</p>}
      {error && <p role="alert" className="agsdl-unresolved">{error}</p>}
    </div>
    <footer><button disabled={locked} onClick={onClose}>{t('agsdl.close')}</button><button className="agsdl-action-button is-primary" disabled={locked || (destination === 'project' ? !session.dirty : !name.trim() || (destination === 'blueprint' && done))} onClick={() => void act()}>{t(busy ? 'agsdl.saving' : destination === 'export' ? 'agsdl.persistence.download' : destination === 'blueprint' ? 'agsdl.persistence.createBlueprint' : 'agsdl.save')}</button></footer>
  </Dialog>;
}
