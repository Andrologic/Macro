import type { ReactNode } from "react";
import type { ProjectInventory } from "../../services/agsdl/projectInventory";
import type { ViewerCard } from "../../services/agsdl/viewer";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Badge } from "../ui/Badge";
import { Icon } from "../ui/Icon";

/** One line for a row: what the author wrote to describe the item, else the start of what it does. */
const summaryOf = (card: ViewerCard) => {
  const description = card.details.description;
  return (typeof description === "string" && description.trim() ? description : card.mission).replace(/\s+/g, " ").trim();
};
export type ComponentListKind = "agents" | "skills" | "tools";
export const componentKind: Record<ComponentListKind, string> = { agents: "Agent", skills: "Skill", tools: "McpServer" };

/**
 * Agents, skills and tools as plain lists. They open the same card as a block of the graph:
 * one way to read an item, one way to edit it.
 */
export function ArchitectComponentList({ kind, cards, inventory, hiddenAgents, onSelect }: {
  kind: ComponentListKind;
  /** Declarations of the assembled document. */
  cards: readonly ViewerCard[];
  inventory: ProjectInventory | null;
  hiddenAgents: readonly string[];
  onSelect: (path: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const items = cards.filter(card => card.kind === componentKind[kind]);
  if (!items.length) return <p className="agsdl-empty text-xs text-muted-foreground">{t(`agsdl.architect.views.empty.${kind}`)}</p>;
  return <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto pt-12 text-xs" aria-label={t(`agsdl.architect.views.${kind}`)}>
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
  </ul>;
}
