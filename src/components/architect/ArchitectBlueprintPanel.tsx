import { useEffect, useMemo, useState } from "react";
import { prepareAgsdlChatContext } from "../../stores/agsdl/chatContext";
import { projectInventory } from "../../services/agsdl/projectInventory";
import { architectLibrary, type BlueprintDraft, type VersionKey } from "../../services/ipc/architectLibrary";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { useArchitectDialogStore } from "../../stores/useArchitectDialogStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { useArchitectViewStore, type ArchitectView } from "../../stores/useArchitectViewStore";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { SidebarMenu, type SidebarMenuPosition } from "../ui/SidebarMenu";
import { Tabs, TabsList, TabsTrigger } from "../ui/Tabs";
import { cn } from "../../utils/cn";
import { ArchitectFilesInspector } from "./ArchitectFilesInspector";
import { ArchitectRecoveryCard } from "./ArchitectRecoveryCard";
import { ArchitectViewer } from "./ArchitectViewer";
import { LibraryReadFailure } from "./BlueprintVersionDialogs";

export function ArchitectBlueprintPanel() {
  const { t } = useAgsdlTranslation();
  const { projectId, blueprintId, draft, draftStatus, version, versionNumber } = useArchitectLibraryStore();
  const selectBlueprint = useArchitectLibraryStore(state => state.selectBlueprint);
  const selectVersion = useArchitectLibraryStore(state => state.selectVersion);
  const open = useArchitectDialogStore(state => state.open);
  const draftTarget = useMemo(() => ({ blueprintId: draft?.id ?? "" }), [draft?.id]);
  const target = versionNumber === null || !draft ? draftTarget : { blueprintId: draft.id, number: versionNumber };
  const key = agsdlSessionKey(target);
  const session = useAgsdlStore(state => state.sessions[key]);
  const view = useArchitectViewStore(state => state.views[key]) ?? "flow";
  const filesVisible = useArchitectViewStore(state => state.filesVisible);
  const recovery = versionNumber === null ? draft?.storageState === "recovery"
    : version.status === "ready" && version.value.storageState === "recovery";

  // Saving a version is the one deliberate act: the draft itself is kept by the editor.
  const saveShortcut = (event: React.KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || !draft || draft.archived || recovery || versionNumber !== null) return;
    event.preventDefault();
    if (!session?.saving && !session?.draftConflict) open({ kind: "saveVersion", blueprintId: draft.id });
  };

  let body: React.ReactNode;
  if (draftStatus === "error" && projectId && blueprintId) body = <LibraryReadFailure retry={() => selectBlueprint(projectId, blueprintId)} />;
  else if (draftStatus === "loading") body = <p className="agsdl-empty" role="status">{t("agsdl.loading")}</p>;
  else if (!draft) body = <div className="agsdl-empty">{t("agsdl.library.chooseBlueprint")}</div>;
  else if (versionNumber !== null && version.status === "error") body = <LibraryReadFailure retry={() => selectVersion(versionNumber)} />;
  else if (versionNumber !== null && version.status !== "ready") body = <p className="agsdl-empty" role="status">{t("agsdl.loading")}</p>;
  else if (recovery) {
    const record = versionNumber === null ? draft : version.status === "ready" ? version.value : undefined;
    body = <ArchitectRecoveryCard blueprintId={draft.id} name={draft.name} projectId={draft.projectId} number={versionNumber}
      revision={record?.revision ?? draft.revision} diagnostics={session?.project?.view.diagnostics ?? record?.project?.diagnostics ?? []}
      technical={record?.diagnostics} />;
  } else body = <>
    <ArchitectPanelHeader draft={draft} versionNumber={versionNumber} view={filesVisible || view !== "files" ? view : "flow"} />
    {view === "files" && filesVisible
      ? <ArchitectFilesInspector target={target} />
      : <ArchitectViewer key={key} target={target} view={view === "files" ? "flow" : view}
        onAttachContext={versionNumber === null && !draft.archived ? selection => prepareAgsdlChatContext(target, selection) : undefined} />}
  </>;

  return <aside className="flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-card" data-tour-id="architect-agsdl-panel"
    onKeyDown={saveShortcut}>{body}</aside>;
}

function useOriginIsRepair(origin: VersionKey | null) {
  const [repair, setRepair] = useState(false);
  useEffect(() => {
    setRepair(false);
    if (!origin) return;
    let active = true;
    architectLibrary.listVersions(origin.blueprintId)
      .then(found => { if (active) setRepair(found.some(entry => entry.number === origin.number && entry.storageState === "recovery")); })
      .catch(() => {});
    return () => { active = false; };
  }, [origin]);
  return repair;
}

function ArchitectPanelHeader({ draft, versionNumber, view }: { draft: BlueprintDraft; versionNumber: number | null; view: ArchitectView }) {
  const { t, i18n } = useAgsdlTranslation();
  const key = agsdlSessionKey(versionNumber === null ? { blueprintId: draft.id } : { blueprintId: draft.id, number: versionNumber });
  const session = useAgsdlStore(state => state.sessions[key]);
  const version = useArchitectLibraryStore(state => state.version);
  const projectBlueprints = useArchitectLibraryStore(state => state.projectBlueprints);
  const selectVersion = useArchitectLibraryStore(state => state.selectVersion);
  const open = useArchitectDialogStore(state => state.open);
  const filesVisible = useArchitectViewStore(state => state.filesVisible);
  const [menu, setMenu] = useState<SidebarMenuPosition>();
  const [exportMenu, setExportMenu] = useState<SidebarMenuPosition>();
  const [noteOpen, setNoteOpen] = useState(false);
  const repairOrigin = useOriginIsRepair(draft.origin);
  const readOnly = versionNumber !== null || draft.archived;
  const source = session?.source;
  const inventory = useMemo(() => source ? projectInventory(source) : null, [source]);
  const record = version.status === "ready" ? version.value : undefined;
  const note = versionNumber !== null ? record?.note : undefined;
  const createdAt = versionNumber !== null && record?.createdAt && !Number.isNaN(Date.parse(record.createdAt))
    ? new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }).format(new Date(record.createdAt)) : undefined;
  const originName = draft.origin ? Object.values(projectBlueprints).flatMap(read => read.status === "ready" ? read.value : [])
    .find(blueprint => blueprint.id === draft.origin!.blueprintId)?.name : undefined;
  const state = versionNumber !== null ? undefined
    : draft.archived ? t("agsdl.library.archivedReadOnly")
      : session?.saving ? t("agsdl.architect.header.saving")
        : session?.dirty ? t("agsdl.architect.header.unsaved") : t("agsdl.architect.header.saved");
  const blocked = !!session?.saving || !!session?.draftConflict;
  const setView = (next: string) => useArchitectViewStore.getState().setView(key, next as ArchitectView);
  const tabs: Array<{ id: ArchitectView; count?: number }> = [
    { id: "flow" },
    { id: "agents", count: inventory?.counts.agents },
    { id: "skills", count: inventory?.counts.skills },
    { id: "tools", count: inventory?.counts.tools },
    ...(filesVisible ? [{ id: "files" as const }] : []),
  ];
  const menuButton = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent";

  return <header className="shrink-0 space-y-1.5 border-b border-border px-3 py-2 text-xs">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <strong className="min-w-0 truncate text-sm" title={draft.name}>{draft.name}</strong>
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground" role="status">
          {versionNumber !== null && <Icon name="lock" size={11} />}
          {versionNumber !== null
            ? [t("agsdl.library.version", { number: versionNumber }), createdAt, t("agsdl.architect.header.readOnly")].filter(Boolean).join(" · ")
            : state}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!readOnly && <Button size="sm" className="!h-7 !px-2.5 !py-0 text-xs" disabled={blocked}
          title={blocked ? t("agsdl.architect.header.saveBlocked") : t("agsdl.architect.header.saveHint")}
          onClick={() => open({ kind: "saveVersion", blueprintId: draft.id })}>{t("agsdl.library.saveVersion")}</Button>}
        {versionNumber !== null && <>
          <Button size="sm" variant="secondary" className="!h-7 !px-2.5 !py-0 text-xs" leftIcon={<Icon name="copy" size={12} />}
            onClick={() => open({ kind: "adapt", source: { kind: "version", key: { blueprintId: draft.id, number: versionNumber } }, name: draft.name, projectId: draft.projectId, repair: false })}>
            {t("agsdl.architect.header.adapt")}</Button>
          <Button size="sm" variant="secondary" className="!h-7 !px-2.5 !py-0 text-xs" aria-haspopup="menu" rightIcon={<Icon name="chevron-down" size={12} />}
            onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setExportMenu({ left: rect.right - 208, top: rect.bottom + 4 }); }}>
            {t("agsdl.architect.header.export")}</Button>
        </>}
        <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-haspopup="menu" aria-label={t("agsdl.architect.header.more")} title={t("agsdl.architect.header.more")}
          onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ left: rect.right - 224, top: rect.bottom + 4 }); }}>
          <Icon name="more-horizontal" size={13} /></button>
      </div>
    </div>
    {menu && <SidebarMenu position={menu} onClose={() => setMenu(undefined)} aria-label={t("agsdl.architect.header.more")} className="w-56">
      {versionNumber === null && !draft.archived && <button role="menuitem" type="button" className={menuButton}
        onClick={() => { setMenu(undefined); open({ kind: "export", target: { kind: "draft", blueprintId: draft.id }, name: draft.name }); }}>
        <Icon name="download" size={11} />{t("agsdl.architect.menu.exportDraft")}</button>}
      <button role="menuitemcheckbox" aria-checked={filesVisible} type="button" className={menuButton}
        onClick={() => { setMenu(undefined); useArchitectViewStore.getState().setFilesVisible(!filesVisible); }}>
        <Icon name={filesVisible ? "check-square" : "square"} size={11} />{t("agsdl.architect.header.showFiles")}</button>
    </SidebarMenu>}
    {exportMenu && versionNumber !== null && <SidebarMenu position={exportMenu} onClose={() => setExportMenu(undefined)} aria-label={t("agsdl.architect.header.export")} className="w-52">
      {(["archive", "project"] as const).map(format => <button key={format} role="menuitem" type="button" className={menuButton}
        onClick={() => { setExportMenu(undefined); open({ kind: "export", target: { kind: "version", key: { blueprintId: draft.id, number: versionNumber } }, name: draft.name, format }); }}>
        <Icon name={format === "archive" ? "archive" : "folder-open"} size={11} />{t(`agsdl.architect.header.exportAs.${format}`)}</button>)}
    </SidebarMenu>}
    {versionNumber !== null && <div className="space-y-1">
      {note && <p className={cn("m-0 whitespace-pre-wrap break-words text-muted-foreground", !noteOpen && "line-clamp-2")}>{note}</p>}
      {note && (note.length > 140 || note.includes("\n")) && <button type="button" className="agsdl-link text-[11px]" aria-expanded={noteOpen} onClick={() => setNoteOpen(open => !open)}>
        {t(noteOpen ? "agsdl.architect.header.less" : "agsdl.architect.header.showMore")}</button>}
      <button type="button" className="agsdl-link flex items-center gap-1 text-[11px]" onClick={() => void selectVersion(null)}>
        <Icon name="chevron-left" size={11} />{t(draft.archived ? "agsdl.library.backToArchive" : "agsdl.library.backToDraft")}</button>
    </div>}
    {draft.origin && <p className="m-0 break-words text-muted-foreground">{repairOrigin ? t("agsdl.architect.header.repairOrigin")
      : originName ? t("agsdl.architect.header.origin", { number: draft.origin.number, blueprint: originName })
        : t("agsdl.architect.header.originUnknown", { number: draft.origin.number })}</p>}
    <Tabs value={view} defaultValue="flow" onValueChange={setView}>
      <TabsList className="!rounded-md !p-0.5 text-xs" aria-label={t("agsdl.architect.views.label")}>
        {tabs.map(({ id, count }) => <TabsTrigger key={id} value={id} data-empty={count === 0 ? "true" : undefined}
          className={cn("!rounded !px-2.5 !py-1 !text-xs", count === 0 && "opacity-60")}>
          {t(`agsdl.architect.views.${id}`)}{!!count && count > 1 && <span className="ml-1 text-[10px] text-muted-foreground">{count}</span>}
        </TabsTrigger>)}
      </TabsList>
    </Tabs>
  </header>;
}
