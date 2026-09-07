import { lazy, Suspense, useMemo, useState } from "react";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { useAppStore } from "../../stores/useAppStore";
import {
  getGitFlowBaseBranch,
  resolveTargetBranch,
} from "../../services/architectPlanService";
import { AgsdlEditor } from "../agsdl/AgsdlEditor";
const StrategyGraph = lazy(() => import("../plan/StrategyGraph"));

export default function ArchitectStrategyPanel() {
  const { t } = useAgsdlTranslation();
  const planId = useAppStore((state) => state.activeArchitectPlanId);
  const targetBranch = useAppStore(
    (state) => state.activePlanContext?.targetBranch,
  );
  const planStatus = useAppStore((state) => state.activePlanContext?.status);
  const [legacy, setLegacy] = useState(false);
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
      <div className="flex gap-1 border-b border-border px-2 py-1.5">
        <button
          className="agsdl-button"
          aria-pressed={!legacy}
          onClick={() => setLegacy(false)}
        >
          {t("agsdl.editor")}
        </button>
        <button
          className="agsdl-button"
          aria-pressed={legacy}
          onClick={() => setLegacy(true)}
        >
          {t("agsdl.legacyStrategy")}
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {legacy ? (
          <Suspense
            fallback={<div className="p-4 text-xs">{t("agsdl.loading")}</div>}
          >
            <StrategyGraph />
          </Suspense>
        ) : planId ? (
          <AgsdlEditor
            key={JSON.stringify(target)}
            target={target}
            planStatus={planStatus}
          />
        ) : (
          <div className="agsdl-empty">{t("agsdl.choosePlan")}</div>
        )}
      </div>
    </aside>
  );
}
