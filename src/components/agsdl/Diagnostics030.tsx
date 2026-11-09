import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import { diagnosticExplanation030, type LocalizedDiagnostic } from "../../services/agsdl/diagnostics";

export function Diagnostics030({ issues, onSelect, onAttach, busy, error }: {
  issues: LocalizedDiagnostic[];
  onSelect: (issue: LocalizedDiagnostic) => void;
  onAttach?: (issue: LocalizedDiagnostic) => Promise<void>;
  busy?: boolean;
  error?: string;
}) {
  const { t } = useAgsdlTranslation();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const visible = issues.filter(issue => (filter === "all" || (issue.severity ?? "error") === filter) &&
    `${issue.rule} ${issue.details} ${issue.path ?? ""} ${issue.step?.join("/") ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (!issues.length) return null;
  return <details open className="border-t border-[rgb(var(--border))] shrink-0 text-xs" aria-label={t("agsdl.authoring030.diagnostics.title")}>
    <summary className="px-3 py-2 cursor-pointer">{t("agsdl.authoring030.diagnostics.count", { count: issues.length })}</summary>
    <div className="flex flex-wrap gap-2 px-3 pb-2">
      <select className="min-w-0 flex-1 rounded border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-2 py-1 text-inherit" style={{ width: "auto" }} value={filter} aria-label={t("agsdl.authoring030.diagnostics.filter")} onChange={event => setFilter(event.target.value)}>
        {["all", "error", "warning"].map(value => <option key={value} value={value}>{t(`agsdl.authoring030.diagnostics.${value}`)}</option>)}
      </select>
      <input className="min-w-0 flex-1 rounded border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-2" value={query} aria-label={t("agsdl.authoring030.diagnostics.search")} placeholder={t("agsdl.authoring030.diagnostics.search")} onChange={event => setQuery(event.target.value)} />
    </div>
    <ul className="overflow-y-auto px-3 pb-2 m-0 list-none" style={{ maxHeight: 180 }}>
      {visible.map((issue, index) => <li key={`${issue.rule}:${issue.path}:${index}`} className="flex items-start gap-2 border-t border-[rgb(var(--border))] py-2">
        <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(issue)}>
          <span className="block">{t(`agsdl.authoring030.diagnostics.${issue.severity ?? "error"}`)} · {t(`agsdl.authoring030.diagnostics.explanation.${diagnosticExplanation030(issue.rule)}`)}</span>
          <span className="block break-words text-[rgb(var(--muted-foreground))]">{issue.details}</span>
          <span className="sr-only">{issue.rule} {issue.path} {issue.step?.join("/")}</span>
        </button>
        {onAttach && <button className="agsdl-icon-button" disabled={busy} aria-label={t("agsdl.attachToChat")} title={t("agsdl.attachToChat")} onClick={() => { void onAttach(issue); }}><MessageSquarePlus size={14} /></button>}
      </li>)}
      {!visible.length && <li>{t("agsdl.authoring030.diagnostics.empty")}</li>}
    </ul>
    {error && <p role="alert" className="px-3 pb-2">{error}</p>}
  </details>;
}
