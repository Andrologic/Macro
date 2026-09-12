import { X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import type { reviewDesignChanges } from "../../services/agsdl/designReview";
export function DesignChangesDialog({ review, onSelect, onClose, onUndo, canUndo }: { review: ReturnType<typeof reviewDesignChanges>; onSelect: (path: string) => void; onClose: () => void; onUndo: () => void; canUndo: boolean }) {
  const { t } = useAgsdlTranslation();
  return <Dialog title={t("agsdl.design.changes")} onClose={onClose} closeOnBackdropClick backdropClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" panelClassName="agsdl-detail-modal">
    <header><strong>{t("agsdl.design.changes")}</strong><button className="agsdl-icon-button" onClick={onClose} aria-label={t("agsdl.close")}><X size={16} /></button></header>
    <div className="agsdl-inspector-body"><ul className="agsdl-change-list">{review.changes.map((change, index) => <li key={index}>
      <small>{t(`agsdl.design.${change.kind}`)}</small>{change.path ? <button className="agsdl-link" onClick={() => { onClose(); onSelect(change.path!); }}>{change.title}</button> : <strong>{change.title}</strong>}
      {change.kind === "modified" && <p className="agsdl-muted">{change.aspects?.map(aspect => t(aspect === "identity" ? "agsdl.viewer.componentName" : aspect === "instructions" ? "agsdl.instructions" : aspect === "connections" ? "agsdl.designGraph.exchanges" : "agsdl.macroConfig.title")).join(" · ")}</p>}
      {change.before !== change.after && <details className="agsdl-details"><summary>{t("agsdl.instructions")}</summary>
        {change.before && <><small>{t("agsdl.design.before")}</small><pre>{change.before}</pre></>}
        {change.after && <><small>{t("agsdl.design.after")}</small><pre>{change.after}</pre></>}
      </details>}
    </li>)}</ul>
      {review.configuration && <p>{t("agsdl.design.configChanged")}</p>}
      {review.design && <p>{t("agsdl.design.designChanged")}</p>}
      {review.other && <p>{t("agsdl.design.otherChanged")}</p>}
    </div>
    <footer><button disabled={!canUndo} onClick={() => { onUndo(); onClose(); }}>{t("agsdl.undo")}</button><button onClick={onClose}>{t("agsdl.close")}</button></footer>
  </Dialog>;
}
