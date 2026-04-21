import {
  isCanonicalArchitectPlan,
  isDefaultNewPlanFamilyLabel,
} from "./architectPlanPresentation";

type BlankArchitectPlanIdentityLike = {
  id: string;
  title: string;
  label?: string | null;
  description?: string | null;
  status?: string | null;
  conversationId?: string | null;
};

type BlankArchitectPlanSummaryLike = {
  id: string;
  title: string;
  label?: string | null;
  description?: string | null;
  status?: string | null;
  conversationId?: string | null;
  nodeCount?: number | null;
  predictedBranchCount?: number | null;
  needCount?: number | null;
  chatMessageCount?: number | null;
};

type BlankArchitectPlanRecordLike = {
  id: string;
  title: string;
  label?: string | null;
  description?: string | null;
  status?: string | null;
  conversationId?: string | null;
  nodes?: unknown[] | null;
  predictedBranches?: unknown[] | null;
  needCount?: number | null;
  chatMessageCount?: number | null;
};

const isActivatableBlankArchitectPlan = (input: {
  plan: BlankArchitectPlanIdentityLike | null | undefined;
  nodeCount: number;
  predictedBranchCount: number;
  needCount: number;
  chatMessageCount: number;
}): boolean => {
  const { plan } = input;
  return Boolean(
    plan &&
      (plan.status ?? "draft") === "draft" &&
      isCanonicalArchitectPlan(plan) &&
      isDefaultNewPlanFamilyLabel(plan.label) &&
      (plan.description ?? "").trim().length === 0 &&
      input.nodeCount === 0 &&
      input.predictedBranchCount === 0 &&
      input.needCount === 0 &&
      input.chatMessageCount === 0 &&
      !plan.conversationId,
  );
};

export const isActivatableBlankArchitectPlanSummary = (
  plan: BlankArchitectPlanSummaryLike | null | undefined,
): boolean =>
  isActivatableBlankArchitectPlan({
    plan,
    nodeCount: plan?.nodeCount ?? 0,
    predictedBranchCount: plan?.predictedBranchCount ?? 0,
    needCount: plan?.needCount ?? 0,
    chatMessageCount: plan?.chatMessageCount ?? 0,
  });

export const isActivatableBlankArchitectPlanRecord = (
  plan: BlankArchitectPlanRecordLike | null | undefined,
): boolean =>
  isActivatableBlankArchitectPlan({
    plan,
    nodeCount: plan?.nodes?.length ?? 0,
    predictedBranchCount: plan?.predictedBranches?.length ?? 0,
    needCount: plan?.needCount ?? 0,
    chatMessageCount: plan?.chatMessageCount ?? 0,
  });
