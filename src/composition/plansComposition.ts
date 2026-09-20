import { createLifecycleScope } from '../services/lifecycleScope';
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
  const owner = createLifecycleScope();
  try {
    const getAppState = () => useAppStore.getState();
    owner.own(installArchitectPlanPorts({ getAppState }));
    owner.own(installArchitectPlanRuntimePorts({
      getProjectById: (id) => getAppState().getProjectById(id),
    }));
    owner.own(installArchitectScopePromotionPorts({ getAppState }));
    const plans = createArchitectPlanService({ getAppState });
    owner.own(installArchitectGitFlowPorts({
      getAppState,
      getArchitectPlan: plans.getArchitectPlan,
      updateArchitectPlan: plans.updateArchitectPlan,
      archiveArchitectPlan: plans.archiveArchitectPlan,
      restoreArchitectPlan: plans.restoreArchitectPlan,
      deleteArchitectPlan: plans.deleteArchitectPlan,
      commitArchitectPlanMetadata: plans.commitArchitectPlanMetadata,
    }));
    const cleanup = () => {
      if (stop !== cleanup) return;
      stop = undefined;
      owner.stop();
    };
    stop = cleanup;
    return cleanup;
  } catch (error) {
    owner.stop();
    throw error;
  }
}
