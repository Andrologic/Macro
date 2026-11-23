import { useEffect, useState } from "react";
import { projectFileEntries } from "../../stores/agsdl/projectEdits";
import { agsdlSessionKey, useAgsdlStore, type BlueprintDocumentTarget } from "../../stores/useAgsdlStore";
import { agsdlErrorText } from "../agsdl/errorText";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Dialog } from "../ui/Dialog";

export function ArchitectProjectFiles({ target, onClose }: {
  target: BlueprintDocumentTarget;
  onClose: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const project = session?.project;
  const [path, setPath] = useState("agsdl.json");
  const [error, setError] = useState("");
  const files = project ? projectFileEntries(project) : [];
  const selected = files.some(file => file.path === path) ? path : files[0]?.path;
  const content = selected ? project?.buffers.get(selected) : undefined;
  const revision = session?.persistedRevision;
  useEffect(() => {
    if (!selected) return;
    let active = true;
    void useAgsdlStore.getState().readProjectFile(target, selected)
      .then(() => { if (active) setError(""); })
      .catch(failure => { if (active) setError(agsdlErrorText(failure, t)); });
    return () => { active = false; };
  }, [selected, revision, target, t]);
  const editable = session?.status === "draft";
  const disabled = !!session?.saving || !!session?.draftConflict;
  const title = t("agsdl.library.files");
  return <Dialog title={title} onClose={onClose} closeOnBackdropClick panelClassName="agsdl-detail-modal">
    <header><strong>{title}</strong></header>
    <div className="agsdl-inspector-body space-y-2">
      {selected && <label className="agsdl-edit-field">{t("agsdl.library.file")}
        <select value={selected} onChange={event => setPath(event.target.value)}>
          {files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
        </select>
      </label>}
      {error && <p role="alert">{error}</p>}
      {selected && !content && !error && <p role="status">{t("agsdl.loading")}</p>}
      {selected && content?.kind === "text" && (editable
        ? <textarea rows={16} className="w-full font-mono" aria-label={selected} spellCheck={false}
          value={content.text} disabled={disabled} onChange={event => {
            void useAgsdlStore.getState().applyProjectBatch(target, [{ kind: "write", path: selected, text: event.target.value }], undefined, session.version)
              .then(() => setError("")).catch(failure => setError(agsdlErrorText(failure, t)));
          }} />
        : <pre className="agsdl-source-value">{content.text}</pre>)}
      {content && content.kind !== "text" && <p>{t(content.kind === "binary" ? "agsdl.library.binaryFile" : "agsdl.library.oversizedFile")}</p>}
    </div>
    <footer>
      <button type="button" onClick={onClose}>{t("agsdl.close")}</button>
      {editable && <button type="button" disabled={disabled || !session.dirty} onClick={() => {
        void useAgsdlStore.getState().save(target).then(() => setError("")).catch(failure => setError(agsdlErrorText(failure, t)));
      }}>{t("agsdl.authoring030.saveDraft")}</button>}
    </footer>
  </Dialog>;
}
