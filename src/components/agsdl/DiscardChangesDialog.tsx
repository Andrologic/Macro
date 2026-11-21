import { useRef } from "react";
import { Dialog } from "../ui/Dialog";
import { useAgsdlTranslation } from "./useAgsdlTranslation";

/** Keep the decision visible and focused, even above a scrolled editor. */
export function DiscardChangesDialog({ onCancel, onDiscard }: { onCancel: () => void; onDiscard: () => void }) {
  const { t } = useAgsdlTranslation();
  const cancel = useRef<HTMLButtonElement>(null);
  return <Dialog title={t("agsdl.discardTitle")} onClose={onCancel} initialFocusRef={cancel}
    backdropClassName="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
    panelClassName="agsdl-detail-modal agsdl-discard-modal">
    <header><strong>{t("agsdl.discardTitle")}</strong></header>
    <footer><button ref={cancel} onClick={onCancel}>{t("agsdl.cancel")}</button><button onClick={onDiscard}>{t("agsdl.viewer.discardEdit")}</button></footer>
  </Dialog>;
}
