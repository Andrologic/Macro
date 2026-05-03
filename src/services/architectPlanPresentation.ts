interface ArchitectPlanPresentationShape {
  id: string;
  slug?: string | null;
  title?: string | null;
  label?: string | null;
}

export type ArchitectPlanLifecyclePhase =
  | 'blank'
  | 'editing'
  | 'validated'
  | 'in_progress'
  | 'completed'
  | 'archived'
  | 'deleted';

type ArchitectPlanLifecycleShape = {
  status?: string | null;
  conversationId?: string | null;
  nodes?: unknown[] | null;
  predictedBranches?: unknown[] | null;
  nodeCount?: number | null;
  predictedBranchCount?: number | null;
  needCount?: number | null;
  chatMessageCount?: number | null;
};

export const DEFAULT_NEW_PLAN_LABEL = 'new plan';

const trimToNull = (value?: string | null): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

const DEFAULT_NEW_PLAN_LABEL_PATTERN = /^new plan(?:\s+(\d+))?$/i;

export const isDefaultNewPlanFamilyLabel = (value?: string | null): boolean =>
  DEFAULT_NEW_PLAN_LABEL_PATTERN.test(trimToNull(value) || '');

export const isDefaultNewPlanBaseLabel = (value?: string | null): boolean =>
  (trimToNull(value) || '').toLowerCase() === DEFAULT_NEW_PLAN_LABEL;

export const getDefaultNewPlanLabelNumber = (value?: string | null): number | null => {
  const match = DEFAULT_NEW_PLAN_LABEL_PATTERN.exec(trimToNull(value) || '');
  if (!match) {
    return null;
  }

  return match[1] ? Number.parseInt(match[1], 10) : 0;
};

export const getNextDefaultNewPlanLabel = (
  plans: Array<Pick<ArchitectPlanPresentationShape, 'label'>>
): string => {
  const numbers = plans
    .map((plan) => getDefaultNewPlanLabelNumber(plan.label))
    .filter((value): value is number => value !== null && Number.isFinite(value));

  if (numbers.length === 0) {
    return DEFAULT_NEW_PLAN_LABEL;
  }

  const maxNumber = numbers.reduce((currentMax, value) => Math.max(currentMax, value), 0);
  return maxNumber <= 0
    ? `${DEFAULT_NEW_PLAN_LABEL} 2`
    : `${DEFAULT_NEW_PLAN_LABEL} ${maxNumber + 1}`;
};

export const isCanonicalArchitectPlan = (plan: ArchitectPlanPresentationShape): boolean => {
  const title = trimToNull(plan.title);
  return title === plan.id;
};

export const getArchitectPlanPrimaryName = (plan: ArchitectPlanPresentationShape): string => {
  const label = trimToNull(plan.label);
  const slug = trimToNull(plan.slug);
  if (isCanonicalArchitectPlan(plan) && isDefaultNewPlanFamilyLabel(label)) {
    return label || DEFAULT_NEW_PLAN_LABEL;
  }

  if (isCanonicalArchitectPlan(plan)) {
    return label || plan.id;
  }

  return trimToNull(plan.title) || slug || plan.id;
};

export const getArchitectPlanSecondaryLabel = (
  plan: ArchitectPlanPresentationShape
): string | null => {
  if (!isCanonicalArchitectPlan(plan)) {
    return null;
  }

  const label = trimToNull(plan.label);
  if (isDefaultNewPlanFamilyLabel(label)) {
    return null;
  }

  return label ? plan.id : null;
};

export const getArchitectPlanDisplayName = (plan: ArchitectPlanPresentationShape): string => {
  const primary = getArchitectPlanPrimaryName(plan);
  const secondary = getArchitectPlanSecondaryLabel(plan);
  return secondary ? `${primary} - ${secondary}` : primary;
};

export const getArchitectPlanEditableName = (plan: ArchitectPlanPresentationShape): string => {
  if (isCanonicalArchitectPlan(plan)) {
    return trimToNull(plan.label) || '';
  }

  return trimToNull(plan.title) || '';
};

export const getArchitectPlanConversationTitle = (plan: ArchitectPlanPresentationShape): string =>
  `Plan - ${getArchitectPlanDisplayName(plan)}`;

const normalizeCount = (value?: number | null): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

export const getArchitectPlanLifecyclePhase = (
  plan: ArchitectPlanLifecycleShape
): ArchitectPlanLifecyclePhase => {
  if (plan.status !== 'draft') {
    if (
      plan.status === 'validated' ||
      plan.status === 'in_progress' ||
      plan.status === 'completed' ||
      plan.status === 'archived' ||
      plan.status === 'deleted'
    ) {
      return plan.status;
    }
    return 'editing';
  }

  const nodeCount = Array.isArray(plan.nodes)
    ? plan.nodes.length
    : normalizeCount(plan.nodeCount);
  const predictedBranchCount = Array.isArray(plan.predictedBranches)
    ? plan.predictedBranches.length
    : normalizeCount(plan.predictedBranchCount);
  const needCount = normalizeCount(plan.needCount);
  const chatMessageCount = normalizeCount(plan.chatMessageCount);

  return nodeCount === 0 &&
    predictedBranchCount === 0 &&
    needCount === 0 &&
    chatMessageCount === 0
    ? 'blank'
    : 'editing';
};
