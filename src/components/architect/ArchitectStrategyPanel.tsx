import { useEffect, useMemo, useRef, useState } from "react";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { useAppStore } from "../../stores/useAppStore";
import {
  getGitFlowBaseBranch,
  resolveTargetBranch,
} from "../../services/architectPlanService";
import { AgsdlEditor } from "../agsdl/AgsdlEditor";

export default function ArchitectStrategyPanel() {
  const { t } = useAgsdlTranslation();
  const planId = useAppStore((state) => state.activeArchitectPlanId);
  const targetBranch = useAppStore(
    (state) => state.activePlanContext?.targetBranch,
  );
  const [previousLayout, setPreviousLayout] = useState<{ width: number; leftOpen: boolean } | null>(null);
  const restoreLayout = useRef(previousLayout);
  useEffect(() => () => {
    const previous = restoreLayout.current;
    if (!previous) return;
    const app = useAppStore.getState();
    app.setTemporaryPanelLayout(previous);
  }, []);
  const toggleExpanded = () => {
    const app = useAppStore.getState();
    if (previousLayout) {
      app.setTemporaryPanelLayout(previousLayout);
      restoreLayout.current = null;
      setPreviousLayout(null);
    } else {
      const previous = { width: app.rightPanelWidth, leftOpen: app.isLeftPanelOpen };
      restoreLayout.current = previous;
      setPreviousLayout(previous);
      app.setTemporaryPanelLayout({ width: Math.min(600, Math.max(320, window.innerWidth - 320)), leftOpen: false });
    }
  };
  const planStatus = useAppStore((state) => state.activePlanContext?.status);
  const target = useMemo(
    () => ({
      branchName: resolveTargetBranch(targetBranch || getGitFlowBaseBranch()),
      planId: planId || "",
    }),
    [planId, targetBranch],
  );
  return (
    <aside
      className="h-full min-h-0 min-w-0 flex flex-col bg-card border-l border-border"
      data-tour-id="architect-strategy-panel"
    >
      <div className="flex-1 min-h-0">
        {planId ? (
          <AgsdlEditor
            key={JSON.stringify(target)}
            target={target}
            planStatus={planStatus}
            expanded={previousLayout !== null}
            onExpand={toggleExpanded}
          />
        ) : (
          <div className="agsdl-empty">{t("agsdl.choosePlan")}</div>
        )}
      </div>
    </aside>
  );
}
