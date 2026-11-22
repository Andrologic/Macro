import { CopyPlus, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { getGitFlowBaseBranch, resolveTargetBranch } from "../../services/architectPlanService";
import { demoWorkflowJourney } from "../../services/operateWorkspace";
import { agsdlSessionKey, useAgsdlStore, type AgsdlDocumentTarget } from "../../stores/useAgsdlStore";
import { useAppStore } from "../../stores/useAppStore";
import { useArchitectLibraryStore } from "../../stores/useArchitectLibraryStore";
import { AgsdlEditor } from "../agsdl/AgsdlEditor";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Dialog } from "../ui/Dialog";
import { BlueprintNameDialog, LibraryReadFailure, SaveBlueprintVersionDialog } from "./BlueprintVersionDialogs";

export default function ArchitectStrategyPanel() {
  return demoWorkflowJourney ? <DemoArchitectStrategyPanel /> : <ArchitectBlueprintPanel />;
}

export function DemoArchitectStrategyPanel() {
  const { t } = useAgsdlTranslation();
  const planId = useAppStore(state => state.activeArchitectPlanId);
  const branch = useAppStore(state => state.activePlanContext?.targetBranch);
  const status = useAppStore(state => state.activePlanContext?.status);
  const target = useMemo(() => ({ branchName: resolveTargetBranch(branch || getGitFlowBaseBranch()), planId: planId || "" }), [branch, planId]);
  return <aside className="flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-card" data-tour-id="architect-agsdl-panel">
    {planId ? <ArchitectViewer key={agsdlSessionKey(target)} target={target} planStatus={status} /> : <div className="agsdl-empty">{t("agsdl.choosePlan")}</div>}
  </aside>;
}

function ArchitectBlueprintPanel() {
  const { t } = useAgsdlTranslation();
  const { projectId, blueprintId, draft, draftStatus, version, versionNumber, projects } = useArchitectLibraryStore();
  const selectBlueprint = useArchitectLibraryStore(state => state.selectBlueprint);
  const selectVersion = useArchitectLibraryStore(state => state.selectVersion);
  const draftTarget = useMemo(() => ({ blueprintId: draft?.id ?? "" }), [draft?.id]);

  return <aside className="flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-card" data-tour-id="architect-agsdl-panel">
    {draftStatus === "error" && projectId && blueprintId
      ? <LibraryReadFailure retry={() => selectBlueprint(projectId, blueprintId)} />
      : draftStatus === "loading" ? <p className="agsdl-empty" role="status">{t("agsdl.loading")}</p>
        : !draft ? <div className="agsdl-empty">{t("agsdl.library.chooseBlueprint")}</div>
          : <>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border px-3 py-2 text-xs">
              <strong className="min-w-0 truncate" title={draft.name}>{draft.name}</strong>
              <span className="text-muted-foreground">
                {versionNumber !== null ? t("agsdl.library.versionReadOnly", { number: versionNumber })
                  : t(draft.archived ? "agsdl.library.archivedReadOnly" : "agsdl.library.draft")}
              </span>
              {versionNumber !== null && <button type="button" className="agsdl-link" onClick={() => void selectVersion(null)}>
                {t(draft.archived ? "agsdl.library.backToArchive" : "agsdl.library.backToDraft")}
              </button>}
              {version.status === "ready" && version.value.note && <p className="w-full whitespace-pre-wrap break-words text-muted-foreground">{version.value.note}</p>}
              {draft.origin && <p className="w-full break-all text-muted-foreground">
                {t("agsdl.library.origin", { blueprint: draft.origin.blueprintId, number: draft.origin.number })}
              </p>}
            </div>
            {versionNumber === null
              ? <ArchitectViewer key={agsdlSessionKey(draftTarget)} target={draftTarget} canSaveVersion={!draft.archived} />
              : version.status === "ready"
                ? <ArchitectViewer key={agsdlSessionKey(version.value)} target={version.value}
                    adaptation={projects.status === "ready" ? { name: draft.name, projectId: draft.projectId, projects: projects.value } : undefined} />
                : version.status === "error" ? <LibraryReadFailure retry={() => selectVersion(versionNumber)} />
                  : <p className="agsdl-empty" role="status">{t("agsdl.loading")}</p>}
          </>}
  </aside>;
}

function ArchitectViewer({ target, planStatus, canSaveVersion, adaptation }: {
  target: AgsdlDocumentTarget;
  planStatus?: string;
  canSaveVersion?: boolean;
  adaptation?: { name: string; projectId: string; projects: Array<{ id: string; name: string }> };
}) {
  const { t } = useAgsdlTranslation();
  const blueprintId = "blueprintId" in target ? target.blueprintId : undefined;
  const number = "blueprintId" in target ? target.number : undefined;
  const session = useAgsdlStore(state => state.sessions[agsdlSessionKey(target)]);
  const [expanded, setExpanded] = useState(false);
  const [versionDialog, setVersionDialog] = useState(false);
  const [adaptDialog, setAdaptDialog] = useState(false);
  const actions = <>
    {canSaveVersion && <button type="button" className="agsdl-icon-button" disabled={session?.saving || !!session?.draftConflict}
      title={t("agsdl.library.saveVersion")} aria-label={t("agsdl.library.saveVersion")} onClick={() => setVersionDialog(true)}><Save size={14} /></button>}
    {adaptation && <button type="button" className="agsdl-icon-button"
      title={t("agsdl.library.adaptVersion")} aria-label={t("agsdl.library.adaptVersion")} onClick={() => setAdaptDialog(true)}><CopyPlus size={14} /></button>}
  </>;
  const editor = (inDialog = false) => <AgsdlEditor target={target} planStatus={planStatus} expanded={inDialog}
    onExpand={() => setExpanded(!inDialog)} canvasActions={actions} />;
  return <div className="relative min-h-0 flex-1">
    {editor()}
    {expanded && <Dialog title={t("agsdl.editor")} onClose={() => setExpanded(false)} closeOnBackdropClick
      panelClassName="flex h-[min(90vh,960px)] w-[min(94vw,1440px)] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      {editor(true)}
    </Dialog>}
    {versionDialog && blueprintId && <SaveBlueprintVersionDialog blueprintId={blueprintId} onClose={() => setVersionDialog(false)} />}
    {adaptDialog && adaptation && blueprintId && number !== undefined && <BlueprintNameDialog title={t("agsdl.library.adaptVersion")}
      initialName={adaptation.name} destinations={adaptation}
      onSave={(name, projectId) => useArchitectLibraryStore.getState().adaptVersion({ blueprintId, number }, projectId, name)}
      onClose={() => setAdaptDialog(false)} />}
  </div>;
}
