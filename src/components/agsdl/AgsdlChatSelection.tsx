import { Network, ScanSearch } from "lucide-react";
import { useAgsdlTranslation } from "./useAgsdlTranslation";

export function AgsdlSentSelection({ title, review }: { title: string; review: boolean }) {
  const { t } = useAgsdlTranslation();
  const Icon = review ? ScanSearch : Network;
  return <span data-agsdl-sent-selection="true" className="mr-1 inline-flex max-w-full items-center gap-1 rounded-md border border-primary/20 bg-primary/10 px-1.5 py-0.5 align-middle text-xs text-primary">
    <Icon size={12} aria-hidden="true" />
    <span className="truncate">{review ? t("agsdl.chatReview") : t("agsdl.chatSystem")} · {title}</span>
  </span>;
}
