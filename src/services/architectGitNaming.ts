import type { GitFlowBranchType, ProjectGitFlowSettings } from '../types';
import { PREF_DEFAULTS, PREF_KEYS } from './preferences';

export interface ArchitectGitNamingSettings extends ProjectGitFlowSettings {
  syncTargetBeforeFinish: boolean;
}

type NonPlanGitFlowBranchType = Exclude<GitFlowBranchType, 'plan'>;

const TEMPLATE_KEY_BY_BRANCH_TYPE: Record<GitFlowBranchType, keyof ProjectGitFlowSettings> = {
  plan: 'planBranchTemplate',
  feature: 'featureBranchTemplate',
  release: 'releaseBranchTemplate',
  hotfix: 'hotfixBranchTemplate',
  bugfix: 'bugfixBranchTemplate',
};

const REQUIRED_TOKENS_BY_BRANCH_TYPE: Record<GitFlowBranchType, string[]> = {
  plan: ['{planSlug}'],
  feature: ['{planSlug}', '{featureSlug}'],
  release: ['{releaseSlug}'],
  hotfix: ['{hotfixSlug}'],
  bugfix: ['{bugfixSlug}'],
};

const DEFAULT_PROJECT_SETTINGS: ProjectGitFlowSettings = {
  baseBranch: String(PREF_DEFAULTS[PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH] || 'develop'),
  planBranchTemplate: String(PREF_DEFAULTS[PREF_KEYS.ARCHITECT_PLAN_BRANCH_TEMPLATE] || 'plan/{planSlug}'),
  featureBranchTemplate: String(
    PREF_DEFAULTS[PREF_KEYS.ARCHITECT_FEATURE_BRANCH_TEMPLATE] || 'feature/{planSlug}/{featureSlug}'
  ),
  releaseBranchTemplate: String(
    PREF_DEFAULTS[PREF_KEYS.ARCHITECT_RELEASE_BRANCH_TEMPLATE] || 'release/{releaseSlug}'
  ),
  hotfixBranchTemplate: String(
    PREF_DEFAULTS[PREF_KEYS.ARCHITECT_HOTFIX_BRANCH_TEMPLATE] || 'hotfix/{hotfixSlug}'
  ),
  bugfixBranchTemplate: String(
    PREF_DEFAULTS[PREF_KEYS.ARCHITECT_BUGFIX_BRANCH_TEMPLATE] || 'bugfix/{bugfixSlug}'
  ),
};

const DEFAULT_SETTINGS: ArchitectGitNamingSettings = {
  ...DEFAULT_PROJECT_SETTINGS,
  syncTargetBeforeFinish: Boolean(PREF_DEFAULTS[PREF_KEYS.ARCHITECT_SYNC_TARGET_BEFORE_FINISH] ?? true),
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
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^refs\/heads\//, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
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

const readStoredBoolean = (key: string): boolean | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`macro_${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeProjectGitFlowSettings = (
  settings?: Partial<ProjectGitFlowSettings> | null
): ProjectGitFlowSettings => ({
  baseBranch: normalizeBranchName(settings?.baseBranch || DEFAULT_PROJECT_SETTINGS.baseBranch, DEFAULT_PROJECT_SETTINGS.baseBranch),
  planBranchTemplate: normalizeTemplate(
    settings?.planBranchTemplate || DEFAULT_PROJECT_SETTINGS.planBranchTemplate,
    DEFAULT_PROJECT_SETTINGS.planBranchTemplate
  ),
  featureBranchTemplate: normalizeTemplate(
    settings?.featureBranchTemplate || DEFAULT_PROJECT_SETTINGS.featureBranchTemplate,
    DEFAULT_PROJECT_SETTINGS.featureBranchTemplate
  ),
  releaseBranchTemplate: normalizeTemplate(
    settings?.releaseBranchTemplate || DEFAULT_PROJECT_SETTINGS.releaseBranchTemplate,
    DEFAULT_PROJECT_SETTINGS.releaseBranchTemplate
  ),
  hotfixBranchTemplate: normalizeTemplate(
    settings?.hotfixBranchTemplate || DEFAULT_PROJECT_SETTINGS.hotfixBranchTemplate,
    DEFAULT_PROJECT_SETTINGS.hotfixBranchTemplate
  ),
  bugfixBranchTemplate: normalizeTemplate(
    settings?.bugfixBranchTemplate || DEFAULT_PROJECT_SETTINGS.bugfixBranchTemplate,
    DEFAULT_PROJECT_SETTINGS.bugfixBranchTemplate
  ),
});

const getTemplateForBranchType = (
  branchType: GitFlowBranchType,
  settings: ProjectGitFlowSettings
): string => settings[TEMPLATE_KEY_BY_BRANCH_TYPE[branchType]];

const validateTemplateForBranchType = (
  branchType: GitFlowBranchType,
  template: string
): string[] => {
  const errors: string[] = [];
  const requiredTokens = REQUIRED_TOKENS_BY_BRANCH_TYPE[branchType];

  for (const token of requiredTokens) {
    if (!template.includes(token)) {
      errors.push(`${branchType} branch template must include ${token}.`);
    }
  }

  return errors;
};

const replaceTemplateTokens = (
  template: string,
  replacements: Record<string, string>
): string => {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`{${key}}`, value);
  }
  return output;
};

export const getDefaultProjectGitFlowSettings = (): ProjectGitFlowSettings =>
  normalizeProjectGitFlowSettings({
    baseBranch: readStoredValue(PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH) || DEFAULT_PROJECT_SETTINGS.baseBranch,
    planBranchTemplate:
      readStoredValue(PREF_KEYS.ARCHITECT_PLAN_BRANCH_TEMPLATE) || DEFAULT_PROJECT_SETTINGS.planBranchTemplate,
    featureBranchTemplate:
      readStoredValue(PREF_KEYS.ARCHITECT_FEATURE_BRANCH_TEMPLATE) || DEFAULT_PROJECT_SETTINGS.featureBranchTemplate,
    releaseBranchTemplate:
      readStoredValue(PREF_KEYS.ARCHITECT_RELEASE_BRANCH_TEMPLATE) || DEFAULT_PROJECT_SETTINGS.releaseBranchTemplate,
    hotfixBranchTemplate:
      readStoredValue(PREF_KEYS.ARCHITECT_HOTFIX_BRANCH_TEMPLATE) || DEFAULT_PROJECT_SETTINGS.hotfixBranchTemplate,
    bugfixBranchTemplate:
      readStoredValue(PREF_KEYS.ARCHITECT_BUGFIX_BRANCH_TEMPLATE) || DEFAULT_PROJECT_SETTINGS.bugfixBranchTemplate,
  });

export const resolveProjectGitFlowSettings = (
  settings?: Partial<ProjectGitFlowSettings> | null
): ProjectGitFlowSettings => normalizeProjectGitFlowSettings(settings ?? getDefaultProjectGitFlowSettings());

export const getArchitectGitNamingSettings = (): ArchitectGitNamingSettings => ({
  ...getDefaultProjectGitFlowSettings(),
  syncTargetBeforeFinish:
    readStoredBoolean(PREF_KEYS.ARCHITECT_SYNC_TARGET_BEFORE_FINISH) ?? DEFAULT_SETTINGS.syncTargetBeforeFinish,
});

export const validateProjectGitFlowSettings = (settings: ProjectGitFlowSettings): string[] => {
  const errors: string[] = [];
  const normalized = normalizeProjectGitFlowSettings(settings);

  if (!normalized.baseBranch) {
    errors.push('Base branch cannot be empty.');
  }

  (Object.keys(TEMPLATE_KEY_BY_BRANCH_TYPE) as GitFlowBranchType[]).forEach((branchType) => {
    const template = getTemplateForBranchType(branchType, normalized);
    errors.push(...validateTemplateForBranchType(branchType, template));
  });

  return errors;
};

export const validateArchitectGitNamingSettings = (settings: ArchitectGitNamingSettings): string[] =>
  validateProjectGitFlowSettings(settings);

export const sanitizeBranchSlugInput = (
  value: string,
  branchType: NonPlanGitFlowBranchType = 'feature'
): string => {
  const fallbackByType: Record<NonPlanGitFlowBranchType, string> = {
    feature: 'work',
    release: 'release',
    hotfix: 'hotfix',
    bugfix: 'bugfix',
  };
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const leaf = normalized.split('/').filter(Boolean).pop() || normalized;
  return sanitizeSlug(leaf, fallbackByType[branchType]);
};

export const normalizeFeatureSlugInput = (value: string): string => sanitizeBranchSlugInput(value, 'feature');

export const renderGitFlowBranchName = (params: {
  branchType: GitFlowBranchType;
  planSlug?: string;
  branchSlug?: string;
  settings?: Partial<ProjectGitFlowSettings> | null;
}): string => {
  const settings = resolveProjectGitFlowSettings(params.settings);
  const safePlanSlug = sanitizeSlug(params.planSlug || 'plan', 'plan');
  const safeBranchSlug = sanitizeBranchSlugInput(
    params.branchSlug || '',
    params.branchType === 'plan' ? 'feature' : params.branchType
  );
  const replacements: Record<string, string> = {
    planSlug: safePlanSlug,
    featureSlug: safeBranchSlug,
    releaseSlug: safeBranchSlug,
    hotfixSlug: safeBranchSlug,
    bugfixSlug: safeBranchSlug,
  };
  const template = getTemplateForBranchType(params.branchType, settings);
  const fallbackByType: Record<GitFlowBranchType, string> = {
    plan: `plan/${safePlanSlug}`,
    feature: `feature/${safePlanSlug}/${safeBranchSlug}`,
    release: `release/${safeBranchSlug}`,
    hotfix: `hotfix/${safeBranchSlug}`,
    bugfix: `bugfix/${safeBranchSlug}`,
  };

  return normalizeBranchName(
    replaceTemplateTokens(template, replacements),
    fallbackByType[params.branchType]
  );
};

export const toPlanIntegrationBranchName = (
  planSlug: string,
  settings?: Partial<ProjectGitFlowSettings> | null
): string =>
  renderGitFlowBranchName({
    branchType: 'plan',
    planSlug,
    settings,
  });

export const toPlanFeatureBranchName = (
  planSlug: string,
  featureSlug: string,
  settings?: Partial<ProjectGitFlowSettings> | null
): string =>
  renderGitFlowBranchName({
    branchType: 'feature',
    planSlug,
    branchSlug: featureSlug,
    settings,
  });

export const getProjectBaseBranch = (settings?: Partial<ProjectGitFlowSettings> | null): string =>
  resolveProjectGitFlowSettings(settings).baseBranch;

export const shouldSyncTargetBranchBeforeFinish = (): boolean =>
  getArchitectGitNamingSettings().syncTargetBeforeFinish;
