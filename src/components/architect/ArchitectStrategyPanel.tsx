import { useMemo } from "react";
import { getGitFlowBaseBranch, resolveTargetBranch } from "../../services/architectPlanService";
import { demoWorkflowJourney } from "../../services/operateWorkspace";
import { agsdlSessionKey } from "../../stores/useAgsdlStore";
import { useAppStore } from "../../stores/useAppStore";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { ArchitectBlueprintPanel } from "./ArchitectBlueprintPanel";
import { ArchitectViewer } from "./ArchitectViewer";

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
