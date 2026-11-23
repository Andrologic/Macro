import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Dialog } from "../ui/Dialog";

/** The shared frame of Architect's dialogs: same header, scrolling body and footer as the component cards. */
export function ArchitectDialogShell({ title, subtitle, locked = false, wide = false, footer, children, onClose }: {
  title: string;
  subtitle?: ReactNode;
  /** An operation is running: closing is refused until it ends. */
  locked?: boolean;
  wide?: boolean;
  footer: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  const { t } = useAgsdlTranslation();
  return <Dialog title={title} onClose={() => { if (!locked) onClose(); }} closeOnBackdropClick={!locked}
    panelClassName={wide ? "agsdl-detail-modal !w-[min(680px,100%)]" : "agsdl-detail-modal"}>
    <header>
      <div className="min-w-0 flex-1">
        <strong className="block truncate" title={title}>{title}</strong>
        {subtitle && <div className="mt-0.5 truncate text-xs font-normal text-muted-foreground">{subtitle}</div>}
      </div>
      <button type="button" className="agsdl-icon-button" disabled={locked} onClick={onClose} aria-label={t("agsdl.close")}><X size={16} /></button>
    </header>
    <div className="agsdl-inspector-body space-y-3 text-xs">{children}</div>
    <footer>{footer}</footer>
  </Dialog>;
}

/** A neutral information block. Never an alarm. */
export function InfoBlock({ icon, title, children }: { icon: ReactNode; title?: string; children: ReactNode }) {
  return <div className="flex gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs">
    <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true">{icon}</span>
    <div className="min-w-0 space-y-1">{title && <p className="!m-0 font-medium">{title}</p>}{children}</div>
  </div>;
}
