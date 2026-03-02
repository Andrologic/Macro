import { PREF_DEFAULTS, PREF_KEYS } from './preferences';

export interface ArchitectGitNamingSettings {
  baseBranch: string;
  planBranchTemplate: string;
  featureBranchTemplate: string;
}

const DEFAULT_SETTINGS: ArchitectGitNamingSettings = {
  baseBranch: String(PREF_DEFAULTS[PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH] || 'develop'),
  planBranchTemplate: String(PREF_DEFAULTS[PREF_KEYS.ARCHITECT_PLAN_BRANCH_TEMPLATE] || 'plan/{planSlug}'),
  featureBranchTemplate: String(
    PREF_DEFAULTS[PREF_KEYS.ARCHITECT_FEATURE_BRANCH_TEMPLATE] || 'feature/{planSlug}/{featureSlug}'
  ),
};

const normalizeBranchName = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^refs\/heads\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return normalized || fallback;
};

const sanitizeSlug = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return normalized || fallback;
};

const normalizeTemplate = (value: string, fallback: string): string => {
  const cleaned = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^refs\/heads\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\s+/g, '-');
  return cleaned || fallback;
};

const readStoredValue = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`macro_${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
};

export const getArchitectGitNamingSettings = (): ArchitectGitNamingSettings => {
  const baseBranch = normalizeBranchName(
    readStoredValue(PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH) || DEFAULT_SETTINGS.baseBranch,
    DEFAULT_SETTINGS.baseBranch
  );
  const planBranchTemplate = normalizeTemplate(
    readStoredValue(PREF_KEYS.ARCHITECT_PLAN_BRANCH_TEMPLATE) || DEFAULT_SETTINGS.planBranchTemplate,
    DEFAULT_SETTINGS.planBranchTemplate
  );
  const featureBranchTemplate = normalizeTemplate(
    readStoredValue(PREF_KEYS.ARCHITECT_FEATURE_BRANCH_TEMPLATE) || DEFAULT_SETTINGS.featureBranchTemplate,
    DEFAULT_SETTINGS.featureBranchTemplate
  );

  return { baseBranch, planBranchTemplate, featureBranchTemplate };
};

export const validateArchitectGitNamingSettings = (settings: ArchitectGitNamingSettings): string[] => {
  const errors: string[] = [];

  const baseBranch = normalizeBranchName(settings.baseBranch, DEFAULT_SETTINGS.baseBranch);
  const planTemplate = normalizeTemplate(settings.planBranchTemplate, DEFAULT_SETTINGS.planBranchTemplate);
  const featureTemplate = normalizeTemplate(settings.featureBranchTemplate, DEFAULT_SETTINGS.featureBranchTemplate);

  if (!baseBranch) {
    errors.push('Base branch cannot be empty.');
  }

  if (!planTemplate.includes('{planSlug}')) {
    errors.push('Plan branch template must include {planSlug}.');
  }

  if (!featureTemplate.includes('{planSlug}')) {
    errors.push('Feature branch template must include {planSlug}.');
  }

  if (!featureTemplate.includes('{featureSlug}')) {
    errors.push('Feature branch template must include {featureSlug}.');
  }

  return errors;
};

export const toPlanIntegrationBranchName = (planSlug: string): string => {
  const settings = getArchitectGitNamingSettings();
  return normalizeBranchName(
    settings.planBranchTemplate.replace('{planSlug}', sanitizeSlug(planSlug, 'plan')),
    `plan/${sanitizeSlug(planSlug, 'plan')}`
  );
};

export const toPlanFeatureBranchName = (planSlug: string, featureSlug: string): string => {
  const settings = getArchitectGitNamingSettings();
  const safePlanSlug = sanitizeSlug(planSlug, 'plan');
  const safeFeatureSlug = sanitizeSlug(featureSlug, 'work');
  const rendered = settings.featureBranchTemplate
    .replaceAll('{planSlug}', safePlanSlug)
    .replaceAll('{featureSlug}', safeFeatureSlug);
  return normalizeBranchName(rendered, `feature/${safePlanSlug}/${safeFeatureSlug}`);
};

export const normalizeFeatureSlugInput = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const leaf = normalized.split('/').filter(Boolean).pop() || normalized;
  return sanitizeSlug(leaf, 'work');
};
