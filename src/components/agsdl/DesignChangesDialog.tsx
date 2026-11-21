import { DisclosureSummary } from "./DisclosureSummary";
import { X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import type { reviewDesignChanges } from "../../services/agsdl/designReview";
export function DesignChangesDialog({ review, onSelect, onClose, onUndo, canUndo }: { review: ReturnType<typeof reviewDesignChanges>; onSelect: (path: string) => void; onClose: () => void; onUndo: () => void; canUndo: boolean }) {
  const { t } = useAgsdlTranslation();
  const aspectLabel = (aspect: string) => t(aspect === "identity" ? "agsdl.viewer.componentName" : aspect === "instructions" ? "agsdl.instructions" : aspect === "connections" ? "agsdl.designGraph.exchanges" : "agsdl.macroConfig.title");
  return <Dialog title={t("agsdl.design.changes")} onClose={onClose} closeOnBackdropClick backdropClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" panelClassName="agsdl-detail-modal">
    <header><strong>{t("agsdl.design.changes")}</strong><button className="agsdl-icon-button" onClick={onClose} aria-label={t("agsdl.close")}><X size={16} /></button></header>
    <div className="agsdl-inspector-body"><ul className="agsdl-change-list">{review.changes.map((change, index) => <li key={index}>
      <small>{t(`agsdl.design.${change.kind}`)}</small>{change.path ? <button className="agsdl-link" onClick={() => { onClose(); onSelect(change.path!); }}>{change.title}</button> : <strong>{change.title}</strong>}
      {change.details?.map(detail => detail.technical ? <span className="agsdl-change-aspect" key={detail.aspect}>{aspectLabel(detail.aspect)}</span> : <details className="agsdl-details" key={detail.aspect}>
        <DisclosureSummary>{aspectLabel(detail.aspect)}</DisclosureSummary>
        <div className={`agsdl-change-comparison${detail.technical ? " agsdl-change-technical" : ""}`}>
          <div><small>{t("agsdl.design.before")}</small><pre>{detail.before || t("agsdl.design.emptyValue")}</pre></div>
          <div><small>{t("agsdl.design.after")}</small><pre>{detail.after || t("agsdl.design.emptyValue")}</pre></div>
        </div>
      </details>)}
      {!change.details?.length && change.before !== change.after && <details className="agsdl-details"><DisclosureSummary>{t("agsdl.instructions")}</DisclosureSummary>
        {change.before !== undefined && <><small>{t("agsdl.design.before")}</small><pre>{change.before || t("agsdl.design.emptyValue")}</pre></>}
        {change.after !== undefined && <><small>{t("agsdl.design.after")}</small><pre>{change.after || t("agsdl.design.emptyValue")}</pre></>}
      </details>}
    </li>)}</ul>
      {review.configuration && <p>{t("agsdl.design.configChanged")}</p>}
      {review.designDetails?.map((detail, index) => <details className="agsdl-details" key={index}>
        <DisclosureSummary>{t(detail.label, { defaultValue: detail.label })}</DisclosureSummary>
        <div className="agsdl-change-comparison"><div><small>{t("agsdl.design.before")}</small><pre>{detail.before || t("agsdl.design.emptyValue")}</pre></div><div><small>{t("agsdl.design.after")}</small><pre>{detail.after || t("agsdl.design.emptyValue")}</pre></div></div>
      </details>)}
      {review.design && !review.designDetails?.length && <p>{t("agsdl.design.designChanged")}</p>}
      {review.other && <p>{t("agsdl.design.otherChanged")}</p>}
    </div>
    <footer><button disabled={!canUndo} onClick={() => { onUndo(); onClose(); }}>{t("agsdl.design.undoChange")}</button><button onClick={onClose}>{t("agsdl.close")}</button></footer>
  </Dialog>;
}
