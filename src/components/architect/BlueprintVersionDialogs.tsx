import { useId, useState, type FormEvent } from "react";
import type { ArchitectProject } from "../../services/ipc/architectLibrary";
import { useArchitectLaunchStore } from "../../stores/useArchitectLaunchStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { agsdlErrorText } from "../agsdl/errorText";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Dialog } from "../ui/Dialog";

export function architectLibraryLabel(item: ArchitectProject, peers: ArchitectProject[]) {
  return peers.some(other => other.id !== item.id && other.name === item.name)
    ? `${item.name} · ${item.id.slice(0, 8)}`
    : item.name;
}

export function BlueprintNameDialog({ title, initialName = "", destinations, onSave, onClose, children }: {
  title: string;
  initialName?: string;
  destinations?: { projects: ArchitectProject[]; projectId: string };
  children?: React.ReactNode;
  onSave: (name: string, projectId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const [name, setName] = useState(initialName);
  const [projectId, setProjectId] = useState(destinations?.projectId ?? "");
  return <LibraryActionDialog title={title} onClose={onClose}
    disabled={!name.trim() || (!!destinations && !projectId)} onSave={() => onSave(name.trim(), projectId)}>
    {children}
    {destinations && <label className="agsdl-edit-field">{t("agsdl.library.project")}
      <select value={projectId} onChange={event => setProjectId(event.target.value)} required>
        <option value="" disabled>{t("agsdl.library.chooseProject")}</option>
        {destinations.projects.map(item => <option key={item.id} value={item.id}>{architectLibraryLabel(item, destinations.projects)}</option>)}
      </select>
    </label>}
    <label className="agsdl-edit-field">{t("agsdl.design.name")}
      <input value={name} onChange={event => setName(event.target.value)} required />
    </label>
  </LibraryActionDialog>;
}

export function SaveBlueprintVersionDialog({ blueprintId, onClose }: { blueprintId: string; onClose: () => void }) {
  const { t } = useAgsdlTranslation();
  const [note, setNote] = useState("");
  const title = t("agsdl.library.saveVersion");
  return <LibraryActionDialog title={title} onClose={onClose}
    onSave={async () => { await useArchitectLibraryStore.getState().saveVersion(blueprintId, note); }}
    alternate={{ label: t("agsdl.launch.saveAndLaunch"), onSave: async () => {
      const version = await useArchitectLibraryStore.getState().saveVersion(blueprintId, note);
      useArchitectLaunchStore.getState().open({ blueprintId: version.blueprintId, number: version.number });
    } }}>
    <label className="agsdl-edit-field">{t("agsdl.library.versionNote")}
      <textarea value={note} onChange={event => setNote(event.target.value)} />
    </label>
  </LibraryActionDialog>;
}

export function LibraryActionDialog({ title, disabled, children, onSave, onClose, alternate }: {
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
  onSave: () => Promise<void>;
  onClose: () => void;
  alternate?: { label: string; onSave: () => Promise<void> };
}) {
  const { t } = useAgsdlTranslation();
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (save: () => Promise<void>) => {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      await save();
      onClose();
    } catch (failure) {
      setError(agsdlErrorText(failure, t));
      setBusy(false);
    }
  };
  return <Dialog title={title} onClose={() => { if (!busy) onClose(); }} closeOnBackdropClick panelClassName="agsdl-detail-modal">
    <header><strong>{title}</strong></header>
    <form id={formId} className="agsdl-inspector-body space-y-3" onSubmit={(event: FormEvent) => { event.preventDefault(); void submit(onSave); }}>
      <fieldset className="space-y-3" disabled={busy}>{children}</fieldset>
      {error && <p role="alert" className="agsdl-unresolved whitespace-pre-line break-words">{error}</p>}
    </form>
    <footer>
      <button type="button" disabled={busy} onClick={onClose}>{t("agsdl.cancel")}</button>
      {alternate && <button type="button" disabled={busy || disabled} onClick={() => void submit(alternate.onSave)}>{alternate.label}</button>}
      <button type="submit" form={formId} disabled={busy || disabled}>{busy ? t("agsdl.saving") : title}</button>
    </footer>
  </Dialog>;
}

export function LibraryReadFailure({ retry }: { retry: () => Promise<void> }) {
  const { t } = useAgsdlTranslation();
  return <div role="alert" className="px-2 py-1">
    {t("agsdl.actionFailed")} <button type="button" className="agsdl-link" onClick={() => void retry()}>{t("agsdl.retry")}</button>
  </div>;
}
