interface ArchitectPlanPresentationShape {
  id: string;
  slug?: string | null;
  title?: string | null;
  label?: string | null;
}

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
  const maxNumber = plans.reduce((currentMax, plan) => {
    const value = getDefaultNewPlanLabelNumber(plan.label);
    return value !== null && Number.isFinite(value) ? Math.max(currentMax, value) : currentMax;
  }, 0);

  return `${DEFAULT_NEW_PLAN_LABEL} ${maxNumber + 1}`;
};

export const isCanonicalArchitectPlan = (plan: ArchitectPlanPresentationShape): boolean => {
  const slug = trimToNull(plan.slug);
  const title = trimToNull(plan.title);
  return slug === plan.id || title === plan.id;
};

export const getArchitectPlanPrimaryName = (plan: ArchitectPlanPresentationShape): string => {
  const label = trimToNull(plan.label);
  if (isCanonicalArchitectPlan(plan) && isDefaultNewPlanFamilyLabel(label)) {
    return label || DEFAULT_NEW_PLAN_LABEL;
  }

  if (isCanonicalArchitectPlan(plan)) {
    return plan.id;
  }

  return trimToNull(plan.title) || plan.id;
};

export const getArchitectPlanSecondaryLabel = (
  plan: ArchitectPlanPresentationShape
): string | null => {
  if (isCanonicalArchitectPlan(plan) && isDefaultNewPlanFamilyLabel(plan.label)) {
    return null;
  }

  if (!isCanonicalArchitectPlan(plan)) {
    return null;
  }

  return trimToNull(plan.label);
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
