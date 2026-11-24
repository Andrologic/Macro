import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BlueprintSummary, type BlueprintVersionSummary,
} from "../../services/ipc/architectLibrary";
import { agsdlSessionKey, useAgsdlStore } from "../../stores/useAgsdlStore";
import { useArchitectDialogStore } from "../../stores/useArchitectDialogStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { agsdlErrorText } from "../agsdl/errorText";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Skeleton } from "../shared/Skeleton";
import { Icon } from "../ui/Icon";
import { PanelHeaderIconButton } from "../ui/PanelHeaderIconButton";
import { SearchBar } from "../ui/SearchBar";
import { SidebarMenu, isSidebarTextInput, sidebarMenuPosition, type SidebarMenuPosition } from "../ui/SidebarMenu";
import { cn } from "../../utils/cn";
import { ArchitectLibraryDialogs } from "./ArchitectLibraryDialogs";
import { chooseImport, downloadOriginal } from "./architectLibraryActions";
import {
  archivedEntries, blueprintMenu, createMenu, importMenu, isDraftModified, libraryEntries, projectMenu, versionMenu,
  visibleVersions, type MenuAction,
} from "./architectLibraryNavigatorModel";
import { BlueprintNameDialog, LibraryReadFailure, architectLibraryLabel } from "./BlueprintVersionDialogs";
import "../agsdl/agsdl.css";

type MenuTarget =
  | { kind: "create" }
  | { kind: "import"; projectId: string }
  | { kind: "project"; projectId: string }
  | { kind: "blueprint"; blueprint: BlueprintSummary }
  | { kind: "version"; blueprint: BlueprintSummary; version: BlueprintVersionSummary };

const EXPANDED_KEY = "macro_architect_library_expanded_v1";
const readExpanded = (): Record<string, boolean> => {
  try { return JSON.parse(localStorage.getItem(EXPANDED_KEY) || "{}") ?? {}; } catch { return {}; }
};
const rowButton = "flex min-h-8 min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70 disabled:cursor-default disabled:opacity-60";
const moreButton = "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 group-hover/row:opacity-100 group-focus-within/row:opacity-100 disabled:pointer-events-none";
const menuItem = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent";

export default function ArchitectLibraryNavigator() {
  const { t, i18n } = useAgsdlTranslation();
  const library = useArchitectLibraryStore();
  const { projectId, projects, blueprintId, draft, versionNumber, versions, projectBlueprints } = library;
  const openDialog = useArchitectDialogStore(state => state.open);
  const importBusy = useRef(false);
  const [expanded, setExpanded] = useState(readExpanded);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [showAllVersions, setShowAllVersions] = useState<string>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creation, setCreation] = useState<{ kind: "project" } | { kind: "blueprint"; projectId: string }>();
  const [menu, setMenu] = useState<{ target: MenuTarget; position: SidebarMenuPosition }>();
  const [error, setError] = useState("");
  const [highlight, setHighlight] = useState<number>();
  const session = useAgsdlStore(state => draft ? state.sessions[agsdlSessionKey({ blueprintId: draft.id })] : undefined);

  useEffect(() => {
    const state = useArchitectLibraryStore.getState();
    void state.refreshProjects();
    void state.refreshBlueprints();
  }, []);
  useEffect(() => { if (projects.status === "ready") void useArchitectLibraryStore.getState().refreshAllBlueprints(); }, [projects]);

  const remember = (next: Record<string, boolean>) => {
    setExpanded(next);
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(next)); } catch { /* A comfort setting. */ }
  };
  const isOpen = (key: string, fallback: boolean) => expanded[key] ?? fallback;
  const toggle = (key: string, fallback: boolean) => remember({ ...expanded, [key]: !isOpen(key, fallback) });

  const projectList = projects.status === "ready" ? projects.value : [];
  const blueprintsOf = (id: string) => { const read = projectBlueprints[id]; return read?.status === "ready" ? read.value : []; };
  const searching = query.trim().length > 0;
  const entries = libraryEntries(projectList, blueprintsOf, query);
  const archived = archivedEntries(projectList, blueprintsOf, query);
  const loading = projects.status === "loading" || projects.status === "idle";
  const versionList = versions.status === "ready" ? versions.value : [];
  const hasRecovery = versionList.some(version => version.storageState === "recovery");
  const modified = isDraftModified(session?.persistedRevision ?? draft?.revision, versionList);
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }), [i18n.language]);

  // Opening a blueprint reveals its project and its own versions.
  const selectedKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!projectId || selectedKey.current === `${projectId}/${blueprintId}`) return;
    selectedKey.current = `${projectId}/${blueprintId}`;
    setExpanded(current => ({ ...current, [`p:${projectId}`]: true, ...(blueprintId ? { [`b:${blueprintId}`]: true } : {}) }));
  }, [projectId, blueprintId]);

  // A freshly saved version is highlighted for a moment, never on first load.
  const lastNumber = useRef<{ blueprintId: string; max: number } | undefined>(undefined);
  useEffect(() => {
    if (!draft || versions.status !== "ready") return;
    const max = Math.max(0, ...versions.value.map(version => version.number));
    const previous = lastNumber.current;
    lastNumber.current = { blueprintId: draft.id, max };
    if (previous?.blueprintId === draft.id && max > previous.max) {
      setHighlight(max);
      const timer = setTimeout(() => setHighlight(undefined), 2000);
      return () => clearTimeout(timer);
    }
  }, [draft, versions]);

  const guarded = async (work: () => Promise<void>) => {
    setError("");
    try { await work(); } catch (failure) { setError(agsdlErrorText(failure, t)); }
  };
  const startImport = (directory: boolean, destination: string | undefined) => {
    const target = destination ?? projectId ?? projectList[0]?.id;
    if (!target || importBusy.current) return;
    importBusy.current = true;
    void guarded(() => chooseImport(directory, target)).finally(() => { importBusy.current = false; });
  };
  const openBlueprint = (blueprint: BlueprintSummary, versionNumber: number | null = null) =>
    guarded(() => library.selectBlueprint(blueprint.projectId, blueprint.id, versionNumber));
  /** Open a blueprint first when the action needs its draft in the editor. */
  const withBlueprint = async (blueprint: BlueprintSummary, versionNumber: number | null, then: () => void) => {
    if (useArchitectLibraryStore.getState().draft?.id !== blueprint.id) await openBlueprint(blueprint, versionNumber);
    then();
  };

  const run = (action: MenuAction, target: MenuTarget) => {
    setMenu(undefined);
    switch (action.id) {
      case "newProject": setCreation({ kind: "project" }); break;
      case "newBlueprint": {
        const id = target.kind === "project" ? target.projectId : projectId ?? projectList[0]?.id;
        if (id) setCreation({ kind: "blueprint", projectId: id });
        break;
      }
      case "importFile": case "importFolder":
        startImport(action.id === "importFolder", target.kind === "project" || target.kind === "import" ? target.projectId : undefined);
        break;
      case "saveVersion": if (target.kind === "blueprint")
        void withBlueprint(target.blueprint, null, () => openDialog({ kind: "saveVersion", blueprintId: target.blueprint.id })); break;
      case "exportDraft": if (target.kind === "blueprint")
        void withBlueprint(target.blueprint, null, () => openDialog({ kind: "export", target: { kind: "draft", blueprintId: target.blueprint.id }, name: target.blueprint.name })); break;
      case "open": if (target.kind === "version") void openBlueprint(target.blueprint, target.version.number); break;
      case "adapt": case "adaptRepair": if (target.kind === "version") openDialog({
        kind: "adapt", source: { kind: "version", key: { blueprintId: target.blueprint.id, number: target.version.number } },
        name: target.blueprint.name, projectId: target.blueprint.projectId, repair: action.id === "adaptRepair" }); break;
      case "exportArchive": case "exportFolder": if (target.kind === "version") openDialog({
        kind: "export", target: { kind: "version", key: { blueprintId: target.blueprint.id, number: target.version.number } },
        name: target.blueprint.name, format: action.id === "exportArchive" ? "archive" : "project" }); break;
      case "downloadOriginal": if (target.kind === "version") void downloadOriginal({
        blueprintId: target.blueprint.id, revision: target.version.revision, number: target.version.number, name: target.blueprint.name }); break;
      case "delete": if (target.kind === "version")
        openDialog({ kind: "deleteVersion", key: { blueprintId: target.blueprint.id, number: target.version.number } }); break;
    }
  };
  const menuActions = (target: MenuTarget): MenuAction[] => target.kind === "create" ? createMenu(projectList.length > 0)
    : target.kind === "import" ? importMenu() : target.kind === "project" ? projectMenu()
      : target.kind === "blueprint" ? blueprintMenu(target.blueprint, target.blueprint.id === draft?.id && draft.storageState === "recovery")
        : versionMenu(target.version);
  const menuLabel = (target: MenuTarget) => target.kind === "version" ? t("agsdl.library.version", { number: target.version.number })
    : target.kind === "blueprint" ? target.blueprint.name : target.kind === "project" ? projectList.find(item => item.id === target.projectId)?.name ?? ""
      : t("agsdl.library.title");
  const openMenu = (target: MenuTarget, position: SidebarMenuPosition) => setMenu({ target, position });
  const rowMenu = (target: MenuTarget) => ({
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      if (isSidebarTextInput(event.target) || !menuActions(target).length) return;
      event.preventDefault(); event.stopPropagation(); openMenu(target, sidebarMenuPosition(event));
    },
  });
  const moreFor = (target: MenuTarget, label: string) => menuActions(target).length > 0 && <button type="button" className={moreButton}
    aria-haspopup="menu" title={label} aria-label={label}
    onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(target, { left: rect.right - 208, top: rect.bottom + 4 }); }}>
    <Icon name="more-horizontal" size={12} />
  </button>;

  const versionRows = (blueprint: BlueprintSummary) => {
    const { rows, hidden } = visibleVersions(versionList, showAllVersions === blueprint.id);
    return <>
      {versions.status === "error" && <LibraryReadFailure retry={library.refreshVersions} />}
      {versions.status === "loading" && <Skeleton className="mx-2 h-6" />}
      {versions.status === "ready" && !rows.length && <p className="px-2 py-1 pl-9 text-[10px] text-muted-foreground">{t("agsdl.library.noVersions")}</p>}
      <ul aria-label={t("agsdl.library.versions")} aria-live="polite">{rows.map(version => {
        const target: MenuTarget = { kind: "version", blueprint, version };
        const recovery = version.storageState === "recovery";
        const selected = versionNumber === version.number;
        return <li key={version.number} className={cn("group/row flex min-w-0 items-center rounded-md pr-1 transition-colors duration-700",
          selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          highlight === version.number && "bg-primary/10")} {...rowMenu(target)}>
          <button type="button" className={cn(rowButton, "pl-9")} aria-current={selected ? "true" : undefined}
            title={version.note ?? undefined} onClick={() => void guarded(() => library.selectVersion(version.number))}>
            <Icon name={recovery ? "triangle-alert" : "lock"} size={11} className={cn("shrink-0", recovery ? "text-amber-500" : "opacity-60")} />
            <span className="shrink-0 text-xs">{t("agsdl.architect.tree.versionShort", { number: version.number })}</span>
            {recovery ? <span className="truncate text-[10px] text-amber-500">{t("agsdl.library.needsRepair").toLocaleLowerCase(i18n.language)}</span>
              : version.note && <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/80">{version.note}</span>}
            {version.createdAt && !Number.isNaN(Date.parse(version.createdAt)) && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">{dateFormat.format(new Date(version.createdAt))}</span>}
          </button>
          {moreFor(target, t("agsdl.architect.tree.versionActions", { number: version.number }))}
        </li>;
      })}</ul>
      {hidden > 0 && <button type="button" className="px-2 py-1 pl-9 text-left text-[10px] text-muted-foreground hover:text-foreground"
        onClick={() => setShowAllVersions(blueprint.id)}>{t("agsdl.architect.tree.olderVersions", { count: hidden })}</button>}
    </>;
  };

  const blueprintRow = (blueprint: BlueprintSummary, projectLabel?: string) => {
    const selected = blueprintId === blueprint.id;
    const open = isOpen(`b:${blueprint.id}`, false) || (selected && searching);
    // The draft row carries the current page when it is shown; otherwise the blueprint does.
    const draftRowShown = selected && open && !!draft && !blueprint.archived;
    const target: MenuTarget = { kind: "blueprint", blueprint };
    // Homonyms in a project are told apart by a short identifier, nothing else.
    const label = architectLibraryLabel(blueprint, blueprintsOf(blueprint.projectId) as BlueprintSummary[]);
    return <li key={blueprint.id}>
      <div className={cn("group/row flex min-w-0 items-center rounded-md pr-1 transition-colors",
        selected && versionNumber === null && !draftRowShown ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")} {...rowMenu(target)}>
        <button type="button" className={cn(rowButton, projectLabel ? "pl-2" : "pl-5")} aria-current={selected && versionNumber === null && !draftRowShown ? "page" : undefined}
          aria-expanded={selected ? open : undefined} title={label}
          onClick={() => {
            if (selected && versionNumber === null) { toggle(`b:${blueprint.id}`, true); return; }
            void openBlueprint(blueprint);
          }}>
          <Icon name="layout-template" size={12} className={cn("shrink-0", selected ? "text-primary" : "opacity-70")} />
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate text-xs", selected && "font-medium")}>{label}</span>
            {projectLabel && <span className="block truncate text-[10px] text-muted-foreground/75">{projectLabel}</span>}
          </span>
          {selected && hasRecovery && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" role="img" aria-label={t("agsdl.architect.tree.hasRepair")} title={t("agsdl.architect.tree.hasRepair")} />}
        </button>
        {moreFor(target, t("agsdl.architect.tree.blueprintActions", { name: label }))}
      </div>
      {selected && open && draft && <div className="space-y-0.5">
        {!blueprint.archived && <button type="button" className={cn("flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 pl-9 text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70",
          versionNumber === null ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
          aria-current={versionNumber === null ? "page" : undefined} onClick={() => void guarded(() => library.selectVersion(null))}>
          <Icon name="edit" size={11} className="shrink-0 opacity-70" />
          <span>{t("agsdl.library.draft")}</span>
          {modified && <span className="ml-auto text-[10px] text-muted-foreground">{t("agsdl.architect.tree.modified")}</span>}
        </button>}
        {versionRows(blueprint)}
      </div>}
    </li>;
  };

  const empty = !loading && projects.status === "ready" && !projectList.length;
  const nothingFound = searching && !entries.length && !archived.length;
  return <nav className="flex h-full min-h-0 flex-col bg-card text-xs" aria-label={t("agsdl.library.title")} data-tour-id="architect-project-navigator"
    onContextMenu={event => { if (isSidebarTextInput(event.target)) return; event.preventDefault(); openMenu({ kind: "create" }, sidebarMenuPosition(event)); }}>
    {menu && <SidebarMenu position={menu.position} onClose={() => setMenu(undefined)} aria-label={menuLabel(menu.target)} className="w-56">
      {menuActions(menu.target).map(action => <button key={action.id} role="menuitem" type="button"
        className={cn(menuItem, action.danger && "text-red-400 hover:bg-red-500/10")} onClick={() => run(action, menu.target)}>
        <Icon name={action.icon} size={11} />{t(`agsdl.architect.menu.${action.id}`)}
      </button>)}
    </SidebarMenu>}
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
      {searchOpen
        ? <SearchBar value={query} onChange={setQuery} placeholder={t("agsdl.architect.tree.search")} className="h-8 min-w-0 flex-1 rounded-md py-1 focus-within:border-border focus-within:ring-0" showClear={false} inputAutoFocus />
        : <div className="flex min-w-0 items-center gap-2"><Icon name="folder-tree" size={15} className="shrink-0 text-primary" />
          <h2 className="truncate text-sm font-semibold text-foreground">{t("agsdl.architect.tree.title")}</h2></div>}
      <div className="flex shrink-0 items-center gap-1">
        <PanelHeaderIconButton icon={searchOpen ? "x" : "search"} label={searchOpen ? t("agsdl.close") : t("agsdl.architect.tree.search")} pressed={searchOpen}
          className={searchOpen ? "h-8 w-8" : undefined} onClick={() => { if (searchOpen) setQuery(""); setSearchOpen(open => !open); }} />
        {!searchOpen && <>
          <PanelHeaderIconButton icon="upload" label={t("agsdl.architect.tree.import")} aria-haspopup="menu" disabled={!projectList.length}
            onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openMenu({ kind: "import", projectId: projectId ?? projectList[0]?.id ?? "" }, { left: rect.right - 224, top: rect.bottom + 4 }); }} />
          <PanelHeaderIconButton icon="plus" label={t("agsdl.architect.tree.new")} aria-haspopup="menu"
            onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openMenu({ kind: "create" }, { left: rect.right - 224, top: rect.bottom + 4 }); }} />
        </>}
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2.5">
      {error && <div role="alert" className="mx-1 mb-2 rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-400">{error}</div>}
      {projects.status === "error" && <LibraryReadFailure retry={library.refreshProjects} />}
      {loading && projects.status !== "error" && <div role="status" className="space-y-1.5">
        <span className="sr-only">{t("agsdl.library.loading")}</span><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>}
      {empty && <div className="mx-2 mt-8 space-y-3 text-center">
        <Icon name="folder" size={22} className="mx-auto text-muted-foreground/45" />
        <p className="text-xs text-muted-foreground">{t("agsdl.architect.tree.empty")}</p>
        <div className="flex justify-center gap-2">
          <button type="button" className="agsdl-action-button is-primary !h-7 !py-0" onClick={() => setCreation({ kind: "project" })}>{t("agsdl.library.newProject")}</button>
        </div>
      </div>}
      {nothingFound && <div className="mx-2 mt-8 text-center"><Icon name="search" size={20} className="mx-auto mb-2 text-muted-foreground/45" />
        <p className="text-xs text-muted-foreground">{t("agsdl.architect.tree.noResults")}</p></div>}
      {entries.map(({ project, blueprints, matched }) => {
        const open = matched || isOpen(`p:${project.id}`, false);
        const target: MenuTarget = { kind: "project", projectId: project.id };
        const read = projectBlueprints[project.id];
        return <section key={project.id} aria-label={project.name} className="mb-1">
          <div className="group/row flex min-h-8 items-center rounded-md pr-1 hover:bg-accent/60" {...rowMenu(target)}>
            <button type="button" className={cn(rowButton, "font-medium text-foreground")} aria-expanded={open} onClick={() => toggle(`p:${project.id}`, false)} title={project.name}>
              <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className="shrink-0 text-muted-foreground" />
              <Icon name={open ? "folder-open" : "folder"} size={12} className="shrink-0 opacity-70" />
              <span className="truncate text-xs">{project.name}</span>
            </button>
            {moreFor(target, t("agsdl.architect.tree.projectActions", { name: project.name }))}
          </div>
          {open && <div>
            {read?.status === "error" && <LibraryReadFailure retry={() => library.refreshProjectBlueprints(project.id)} />}
            {(!read || read.status === "loading") && <Skeleton className="mx-2 h-6" />}
            {read?.status === "ready" && !blueprints.length && !searching && <p className="px-2 py-1 pl-7 text-[10px] text-muted-foreground">
              {t("agsdl.library.noBlueprints")}{" "}
              <button type="button" className="agsdl-link" onClick={() => setCreation({ kind: "blueprint", projectId: project.id })}>{t("agsdl.library.newBlueprint")}</button></p>}
            <ul>{blueprints.map(blueprint => blueprintRow(blueprint))}</ul>
          </div>}
        </section>;
      })}
      {archived.length > 0 && <section aria-label={t("agsdl.library.archives")} className="mt-2 border-t border-border pt-2">
        <h3 className="m-0"><button type="button" aria-expanded={archivedOpen || searching} onClick={() => setArchivedOpen(open => !open)}
          className="flex h-7 w-full items-center gap-1.5 rounded px-1.5 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70">
          <Icon name={archivedOpen || searching ? "chevron-down" : "chevron-right"} size={12} />
          {t("agsdl.architect.tree.archived", { count: archived.length })}</button></h3>
        {(archivedOpen || searching) && <ul>{archived.map(({ project, blueprint }) => blueprintRow(blueprint, project.name))}</ul>}
      </section>}
    </div>
    {creation?.kind === "project" && <BlueprintNameDialog title={t("agsdl.library.newProject")} onSave={library.createProject} onClose={() => setCreation(undefined)} />}
    {creation?.kind === "blueprint" && <BlueprintNameDialog title={t("agsdl.library.newBlueprint")} onSave={name => library.createBlueprint(creation.projectId, name)} onClose={() => setCreation(undefined)} />}
    <ArchitectLibraryDialogs />
  </nav>;
}
