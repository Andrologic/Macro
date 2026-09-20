import { installArchitectPlanRuntimePorts } from '../services/architectPlanRuntimeService';
import { installArchitectScopePromotionPorts } from '../services/architectScopePromotionService';
import { useAppStore } from '../stores/useAppStore';
import { createArchitectPlanService } from '../services/architectPlanService';
import { installArchitectPlanPorts } from '../services/architectPlanReadContext';
import { installArchitectGitFlowPorts } from '../services/architectGitFlowService';

let stop: (() => void) | undefined;

/** Install before loading plans or recovering lifecycle journals. */
export function startPlansComposition(): () => void {
  if (stop) return stop;
  const getAppState = () => useAppStore.getState();
  const releasePlans = installArchitectPlanPorts({ getAppState });
  const releaseRuntime = installArchitectPlanRuntimePorts({
    getProjectById: (id) => getAppState().getProjectById(id),
  });
  const releasePromotion = installArchitectScopePromotionPorts({ getAppState });
  const plans = createArchitectPlanService({ getAppState });
  const releaseGitFlow = installArchitectGitFlowPorts({
    getAppState,
    getArchitectPlan: plans.getArchitectPlan,
    updateArchitectPlan: plans.updateArchitectPlan,
    archiveArchitectPlan: plans.archiveArchitectPlan,
    restoreArchitectPlan: plans.restoreArchitectPlan,
    deleteArchitectPlan: plans.deleteArchitectPlan,
    commitArchitectPlanMetadata: plans.commitArchitectPlanMetadata,
  });
  const cleanup = () => {
    if (stop !== cleanup) return;
    releaseGitFlow();
    releasePromotion();
    releaseRuntime();
    releasePlans();
    stop = undefined;
  };
  stop = cleanup;
  return cleanup;
}
