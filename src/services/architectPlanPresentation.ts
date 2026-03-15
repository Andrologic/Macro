interface ArchitectPlanPresentationShape {
  id: string;
  slug?: string | null;
  title?: string | null;
  label?: string | null;
}

const trimToNull = (value?: string | null): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

export const isCanonicalArchitectPlan = (plan: ArchitectPlanPresentationShape): boolean => {
  const slug = trimToNull(plan.slug);
  const title = trimToNull(plan.title);
  return slug === plan.id || title === plan.id;
};

export const getArchitectPlanPrimaryName = (plan: ArchitectPlanPresentationShape): string => {
  if (isCanonicalArchitectPlan(plan)) {
    return plan.id;
  }

  return trimToNull(plan.title) || plan.id;
};

export const getArchitectPlanSecondaryLabel = (
  plan: ArchitectPlanPresentationShape
): string | null => {
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
