import { useState } from "react";
import type { prepareAgsdlChatContext } from "../../stores/agsdl/chatContext";
import type { AgsdlDocumentTarget } from "../../stores/useAgsdlStore";
import { AgsdlEditor, type AgsdlEditorView } from "../agsdl/AgsdlEditor";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Dialog } from "../ui/Dialog";

/** The editor for one document, with its expanded copy in a dialog. Actions on the blueprint live in the panel header. */
export function ArchitectViewer({ target, planStatus, view = "flow", onAttachContext }: {
  target: AgsdlDocumentTarget;
  planStatus?: string;
  view?: AgsdlEditorView;
  onAttachContext?: (selection: Parameters<typeof prepareAgsdlChatContext>[1]) => Promise<void>;
}) {
  const { t } = useAgsdlTranslation();
  const [expanded, setExpanded] = useState(false);
  const editor = (inDialog = false) => <AgsdlEditor target={target} planStatus={planStatus} expanded={inDialog} view={view}
    onAttachContext={onAttachContext} onExpand={view === "flow" ? () => setExpanded(!inDialog) : undefined} />;
  return <div className="relative min-h-0 flex-1">
    {editor()}
    {expanded && <Dialog title={t("agsdl.editor")} onClose={() => setExpanded(false)} closeOnBackdropClick
      panelClassName="flex h-[min(90vh,960px)] w-[min(94vw,1440px)] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      {editor(true)}
    </Dialog>}
  </div>;
}
