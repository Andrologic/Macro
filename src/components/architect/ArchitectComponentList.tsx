import { useState, type ReactNode } from "react";
import type { ProjectInventory } from "../../services/agsdl/projectInventory";
import type { NewComponentKind } from "../../services/agsdl/newComponent";
import type { ViewerCard } from "../../services/agsdl/viewer";
import type { BlueprintDocumentTarget } from "../../stores/useAgsdlStore";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { AddComponentDialog } from "./AddComponentDialog";

/** One line for a row: what the author wrote to describe the item, else the start of what it does. */
const summaryOf = (card: ViewerCard) => {
  const description = card.details.description;
  return (typeof description === "string" && description.trim() ? description : card.mission).replace(/\s+/g, " ").trim();
};
export type ComponentListKind = "agents" | "skills" | "tools";
export const componentKind: Record<ComponentListKind, string> = { agents: "Agent", skills: "Skill", tools: "McpServer" };
const newKind: Record<ComponentListKind, NewComponentKind> = { agents: "agent", skills: "skill", tools: "tool" };

/** What the author needs to add an item by hand. Absent where nothing can change (a saved version, an archive). */
export interface ComponentAdding {
  target: BlueprintDocumentTarget;
  /** Skills are files: a document without project files cannot hold them. */
  projectFiles: boolean;
  /** Why adding is not possible right now. */
  blockedReason?: string;
}

/**
 * Agents, skills and tools as plain lists. They open the same card as a block of the graph:
 * one way to read an item, one way to edit it.
 */
export function ArchitectComponentList({ kind, cards, inventory, hiddenAgents, adding, onSelect }: {
  kind: ComponentListKind;
  /** Declarations of the assembled document. */
  cards: readonly ViewerCard[];
  inventory: ProjectInventory | null;
  hiddenAgents: readonly string[];
  adding?: ComponentAdding;
  onSelect: (path: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const [dialog, setDialog] = useState(false);
  const items = cards.filter(card => card.kind === componentKind[kind]);
  const offered = adding && (kind !== "skills" || adding.projectFiles) ? adding : undefined;
  const addButton = (extra = "") => offered && <Button type="button" size="sm" variant="secondary" className={`!h-7 !px-2.5 !py-0 text-xs ${extra}`}
    leftIcon={<Icon name="plus" size={12} />} disabled={!!offered.blockedReason} title={offered.blockedReason}
    onClick={() => setDialog(true)}>{t(`agsdl.architect.add.${newKind[kind]}.action`)}</Button>;
  const addDialog = dialog && offered && <AddComponentDialog kind={newKind[kind]} target={offered.target} onClose={() => setDialog(false)} />;

  if (!items.length) return <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-6 pb-8 pt-16 text-center text-xs" role="region" aria-label={t(`agsdl.architect.views.${kind}`)}>
    <Icon name={kind === "tools" ? "server" : kind === "skills" ? "sparkles" : "layout-template"} size={18} className="text-muted-foreground" />
    <p className="!m-0 font-medium">{t(`agsdl.architect.views.empty.${kind}`)}</p>
    <p className="!m-0 max-w-sm text-muted-foreground">{t(offered ? `agsdl.architect.views.emptyHint.${kind}` : "agsdl.architect.views.emptyReadOnly")}</p>
    {addButton("mt-1")}
    {offered?.blockedReason && <p className="!m-0 text-muted-foreground">{offered.blockedReason}</p>}
    {addDialog}
  </div>;
  return <div className="flex min-h-0 flex-1 flex-col">
    {/* The canvas toolbar floats at the right of this band. */}
    <div className="flex h-12 shrink-0 items-center px-3">{addButton()}</div>
    <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto border-t border-border text-xs" aria-label={t(`agsdl.architect.views.${kind}`)}>
      {items.map(card => {
        const users = (kind === "skills" ? inventory?.skillUsers : inventory?.toolUsers)?.get(card.id)?.length ?? 0;
        const inFlow = inventory?.agentsInFlow;
        const unused = kind === "agents" && inFlow && !inFlow.has(card.id);
        const hidden = kind === "agents" && hiddenAgents.includes(card.id);
        const transport = kind === "tools" ? inventory?.toolTransport.get(card.id) : undefined;
        const extras: ReactNode[] = [];
        if (kind !== "agents") extras.push(<span key="users" className="text-muted-foreground">{users
          ? t(`agsdl.architect.views.usedBy.${kind}`, { count: users }) : t("agsdl.architect.views.unused")}</span>);
        return <li key={card.path}>
          <button type="button" onClick={() => onSelect(card.path)}
            className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <strong className="truncate font-medium">{card.title || card.id}</strong>
                {hidden && <Icon name="eye-off" size={11} className="shrink-0 text-muted-foreground" />}
                {hidden && <span className="sr-only">{t("agsdl.library.hiddenAgent")}</span>}
              </span>
              {summaryOf(card) && <span className="line-clamp-1 text-muted-foreground">{summaryOf(card)}</span>}
            </span>
            {transport && <Badge size="sm" className="shrink-0 !px-1.5 !py-0 !text-[10px]">{t(`agsdl.architect.views.transport.${transport}`)}</Badge>}
            {unused
              ? <span className="shrink-0 text-[10px] text-amber-500">{t("agsdl.architect.views.notInFlow")}</span>
              : kind === "agents" && inFlow ? <span className="shrink-0 text-[10px] text-muted-foreground">{t("agsdl.architect.views.inFlow")}</span> : null}
            {extras}
          </button>
        </li>;
      })}
    </ul>
    {addDialog}
  </div>;
}
