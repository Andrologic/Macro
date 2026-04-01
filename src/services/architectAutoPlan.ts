import { createArchitectAutoPlanService } from './architectAutoPlanCore';
import {
  createArchitectPlan,
  getArchitectPlan,
  getArchitectPlanChatMessages,
  getArchitectPlanNeeds,
  getArchitectPlanProjectIds,
  listArchitectPlans,
  setActiveArchitectPlan,
  updateArchitectPlan,
} from './architectPlanService';
import {
  DEFAULT_NEW_PLAN_LABEL,
  getNextDefaultNewPlanLabel,
  getArchitectPlanEditableName,
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
  isDefaultNewPlanBaseLabel,
  listArchitectPlans,
  setActiveArchitectPlan: async (branchName, planId) => {
    if (!planId) {
      return;
    }
    await setActiveArchitectPlan(branchName, planId);
  },
  updateArchitectPlan,
});

export const isArchitectPlanBlankDraft = architectAutoPlanService.isArchitectPlanBlankDraft;
export const ensureScopedBlankPlan = architectAutoPlanService.ensureScopedBlankPlan;
export const ensureProjectGroupPlan = architectAutoPlanService.ensureProjectGroupPlan;
