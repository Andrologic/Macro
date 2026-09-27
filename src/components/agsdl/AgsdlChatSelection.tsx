import { X } from "lucide-react";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { useAgsdlChatContext, type AgsdlChatContext } from "../../stores/agsdl/chatContext";

export function AgsdlChatSelection({ context }: { context: AgsdlChatContext }) {
  const { t } = useAgsdlTranslation();
  return <div className="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs" role="group" aria-label={t("agsdl.chatSelection")}>
    <span className="min-w-0 flex-1 truncate" title={`${context.planId} · ${context.branchName} · ${context.path} · ${context.version}`}>
      {t("agsdl.chatSelection")} · {context.title}
    </span>
    <button type="button" aria-label={t("agsdl.removeChatSelection")} title={t("agsdl.removeChatSelection")} onClick={() => useAgsdlChatContext.getState().remove(context.conversationId, context.id)}><X size={14} /></button>
  </div>;
}
