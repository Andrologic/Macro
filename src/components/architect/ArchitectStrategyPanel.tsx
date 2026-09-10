import { useMemo, useState } from "react";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { useAppStore } from "../../stores/useAppStore";
import {
  getGitFlowBaseBranch,
  resolveTargetBranch,
} from "../../services/architectPlanService";
import { AgsdlEditor } from "../agsdl/AgsdlEditor";
import { Dialog } from "../ui/Dialog";
import type { AgsdlTarget } from "../../stores/useAgsdlStore";

export default function ArchitectStrategyPanel() {
  const planId = useAppStore((state) => state.activeArchitectPlanId);
  const targetBranch = useAppStore(
    (state) => state.activePlanContext?.targetBranch,
  );
  const planStatus = useAppStore((state) => state.activePlanContext?.status);
  const target = useMemo(
    () => ({
      branchName: resolveTargetBranch(targetBranch || getGitFlowBaseBranch()),
      planId: planId || "",
    }),
    [planId, targetBranch],
  );
  return <ArchitectViewer key={JSON.stringify(target)} target={target} planStatus={planStatus} />;
}

function ArchitectViewer({ target, planStatus }: { target: AgsdlTarget; planStatus?: string }) {
  const { t } = useAgsdlTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <aside
      className="h-full min-h-0 min-w-0 flex flex-col bg-card border-l border-border"
      data-tour-id="architect-strategy-panel"
    >
      <div className="flex-1 min-h-0">
        {target.planId ? (
          <AgsdlEditor
            target={target}
            planStatus={planStatus}
            onExpand={() => setExpanded(true)}
          />
        ) : (
          <div className="agsdl-empty">{t("agsdl.choosePlan")}</div>
        )}
      </div>
      {target.planId && expanded && (
        <Dialog
          title={t("agsdl.editor")}
          onClose={() => setExpanded(false)}
          closeOnBackdropClick
          panelClassName="flex h-[min(90vh,960px)] w-[min(94vw,1440px)] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        >
          <AgsdlEditor
            target={target}
            planStatus={planStatus}
            expanded
            onExpand={() => setExpanded(false)}
          />
        </Dialog>
      )}
    </aside>
  );
}
