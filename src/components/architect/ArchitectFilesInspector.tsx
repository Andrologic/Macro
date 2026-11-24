import { useEffect, useMemo, useState } from "react";
import { groupProjectFiles } from "../../services/agsdl/projectInventory";
import { projectFileEntries } from "../../stores/agsdl/projectEdits";
import { agsdlSessionKey, useAgsdlStore, type BlueprintDocumentTarget } from "../../stores/useAgsdlStore";
import { agsdlErrorText } from "../agsdl/errorText";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Icon } from "../ui/Icon";
import { cn } from "../../utils/cn";

/**
 * The files behind a draft or a version, for people who want to see them. Read only:
 * an item is changed through its card or by asking the Architect agent.
 */
export function ArchitectFilesInspector({ target }: { target: BlueprintDocumentTarget }) {
  const { t } = useAgsdlTranslation();
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const project = session?.project;
  const files = useMemo(() => project ? projectFileEntries(project) : [], [project]);
  const groups = useMemo(() => groupProjectFiles(files), [files]);
  const [chosen, setChosen] = useState<string>();
  const [error, setError] = useState("");
  const selected = files.some(file => file.path === chosen) ? chosen : files[0]?.path;
  const content = selected ? project?.buffers.get(selected) : undefined;
  const revision = session?.persistedRevision;

  useEffect(() => {
    if (!selected) return;
    let active = true;
    setError("");
    useAgsdlStore.getState().readProjectFile(target, selected)
      .catch(failure => { if (active) setError(agsdlErrorText(failure, t)); });
    return () => { active = false; };
  }, [selected, revision, target, t]);

  if (!session) return <p className="agsdl-empty" role="status">{t("agsdl.loading")}</p>;
  if (!files.length) return <p className="agsdl-empty text-xs text-muted-foreground">{t("agsdl.architect.views.empty.files")}</p>;
  return <div className="flex min-h-0 flex-1 flex-col text-xs">
    <p className="m-0 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">{t("agsdl.architect.views.filesHint")}</p>
    <nav aria-label={t("agsdl.library.files")} className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border py-1">
      {groups.map(({ group, files: members }) => <section key={group} aria-label={t(`agsdl.architect.views.fileGroup.${group}`)}>
        <h3 className="m-0 px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">{t(`agsdl.architect.views.fileGroup.${group}`)}</h3>
        <ul>{members.map(file => <li key={file.path}>
          <button type="button" aria-current={file.path === selected ? "true" : undefined} onClick={() => setChosen(file.path)}
            className={cn("flex w-full min-w-0 items-center gap-2 px-3 py-1 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70",
              file.path === selected && "bg-accent")}>
            <Icon name="file" size={11} className="shrink-0 opacity-60" /><span className="truncate" title={file.path}>{file.path}</span>
          </button>
        </li>)}</ul>
      </section>)}
    </nav>
    <div className="flex min-h-0 flex-1 flex-col" aria-label={selected}>
      {selected && <p className="m-0 flex items-center gap-1.5 border-b border-border px-3 py-1.5 font-mono text-[11px]"><Icon name="lock" size={10} className="opacity-60" /><span className="truncate" title={selected}>{selected}</span></p>}
      {error && <p role="alert" className="m-0 px-3 py-2 text-red-500">{error}</p>}
      {selected && !content && !error && <p role="status" className="m-0 px-3 py-2 text-muted-foreground">{t("agsdl.loading")}</p>}
      {content?.kind === "text" && <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed">{content.text}</pre>}
      {content && content.kind !== "text" && <p className="m-0 px-3 py-2 text-muted-foreground">{t(content.kind === "binary" ? "agsdl.library.binaryFile" : "agsdl.library.oversizedFile")}</p>}
    </div>
  </div>;
}
