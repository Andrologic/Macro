import { createArchitectAutoPlanService } from './architectAutoPlanCore';
import { useAppStore } from '../stores/useAppStore';
import {
  createArchitectPlan,
  getArchitectPlan,
  getArchitectPlanChatMessages,
  getArchitectPlanNeeds,
  getArchitectPlanProjectIds,
  getGitFlowBaseBranch,
  listArchitectPlans,
  setActiveArchitectPlan,
  updateArchitectPlan,
} from './architectPlanService';
import {
  DEFAULT_NEW_PLAN_LABEL,
  getNextDefaultNewPlanLabel,
  getArchitectPlanEditableName,
  isDefaultNewPlanFamilyLabel,
  isDefaultNewPlanBaseLabel,
  isCanonicalArchitectPlan,
} from './architectPlanPresentation';

const architectAutoPlanService = createArchitectAutoPlanService({
  DEFAULT_NEW_PLAN_LABEL,
  createArchitectPlan,
  getArchitectPlan,
  getArchitectPlanChatMessages,
  getArchitectPlanEditableName,
  getArchitectPlanNeeds,
  getArchitectPlanProjectIds,
  getNextDefaultNewPlanLabel,
  isCanonicalArchitectPlan,
  isDefaultNewPlanFamilyLabel,
  isDefaultNewPlanBaseLabel,
  listArchitectPlans,
  getTargetBranchesByProjectId: (projectIds) => {
    const appState = useAppStore.getState();
    return Object.fromEntries(
      projectIds.map((projectId) => [
        projectId,
        appState.getProjectById(projectId)?.gitFlowSettings?.baseBranch || getGitFlowBaseBranch(),
      ])
    );
  },
  setActiveArchitectPlan: async (branchName, planId) => {
    if (!planId) {
      return;
    }
    await setActiveArchitectPlan(branchName, planId);
  },
  updateArchitectPlan,
});

export const isArchitectPlanBlankDraft = architectAutoPlanService.isArchitectPlanBlankDraft;
export const isReusableBlankDraft = architectAutoPlanService.isReusableBlankDraft;
export const ensureScopedBlankPlan = architectAutoPlanService.ensureScopedBlankPlan;
export const ensureProjectGroupPlan = architectAutoPlanService.ensureProjectGroupPlan;
