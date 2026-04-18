import type { GitFlowBranchType, ProjectGitFlowSettings } from '../types';
import { PREF_DEFAULTS, PREF_KEYS } from './preferences';

export interface ArchitectGitNamingSettings extends ProjectGitFlowSettings {
  syncTargetBeforeFinish: boolean;
}

type NonPlanGitFlowBranchType = Exclude<GitFlowBranchType, 'plan'>;
const FEATURE_SLUG_PATTERN = '[a-z0-9._-]+';
const TEMPLATE_TOKEN_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

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

const TEMPLATE_LABEL_BY_BRANCH_TYPE: Record<GitFlowBranchType, string> = {
  plan: 'Plan branch template',
  feature: 'Feature branch template',
  release: 'Release branch template',
  hotfix: 'Hotfix branch template',
  bugfix: 'Bugfix branch template',
};

const DEFAULT_PROJECT_SETTINGS: ProjectGitFlowSettings = {
  baseBranch: String(PREF_DEFAULTS[PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH] || 'develop'),
  mainBranch: String(PREF_DEFAULTS[PREF_KEYS.ARCHITECT_GIT_MAIN_BRANCH] || 'main'),
  planBranchTemplate: String(PREF_DEFAULTS[PREF_KEYS.ARCHITECT_PLAN_BRANCH_TEMPLATE] || 'plan/{planSlug}'),
  featureBranchTemplate: String(
    PREF_DEFAULTS[PREF_KEYS.ARCHITECT_FEATURE_BRANCH_TEMPLATE] || 'feature/{planSlug}/{featureSlug}'
  ),
  standaloneFeatureBranchTemplate: String(
    PREF_DEFAULTS[PREF_KEYS.ARCHITECT_STANDALONE_FEATURE_BRANCH_TEMPLATE] || 'feature/{featureSlug}'
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

export const normalizeGitBranchName = (
  value?: string | null,
  fallback = '',
): string => {
  const normalized = (value || '')
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
  baseBranch: normalizeGitBranchName(settings?.baseBranch || DEFAULT_PROJECT_SETTINGS.baseBranch, DEFAULT_PROJECT_SETTINGS.baseBranch),
  mainBranch: normalizeGitBranchName(
    settings?.mainBranch || DEFAULT_PROJECT_SETTINGS.mainBranch,
    DEFAULT_PROJECT_SETTINGS.mainBranch
  ),
  planBranchTemplate: normalizeTemplate(
    settings?.planBranchTemplate || DEFAULT_PROJECT_SETTINGS.planBranchTemplate,
    DEFAULT_PROJECT_SETTINGS.planBranchTemplate
  ),
  featureBranchTemplate: normalizeTemplate(
    settings?.featureBranchTemplate || DEFAULT_PROJECT_SETTINGS.featureBranchTemplate,
    DEFAULT_PROJECT_SETTINGS.featureBranchTemplate
  ),
  standaloneFeatureBranchTemplate: normalizeTemplate(
    settings?.standaloneFeatureBranchTemplate || DEFAULT_PROJECT_SETTINGS.standaloneFeatureBranchTemplate,
    DEFAULT_PROJECT_SETTINGS.standaloneFeatureBranchTemplate
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

interface TemplateTokenMatch {
  regex: RegExp;
  tokens: string[];
  duplicateTokens: string[];
  unsupportedTokens: string[];
}

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const compileGitFlowTemplateTokenMatch = (
  template: string,
  allowedTokens: string[],
): TemplateTokenMatch => {
  TEMPLATE_TOKEN_PATTERN.lastIndex = 0;
  const tokens: string[] = [];
  const seenTokens = new Set<string>();
  const duplicateTokens: string[] = [];
  const unsupportedTokens: string[] = [];
  const parts: string[] = ['^'];
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  while ((match = TEMPLATE_TOKEN_PATTERN.exec(template)) !== null) {
    const token = match[1];
    if (!allowedTokens.includes(token)) {
      unsupportedTokens.push(token);
      parts.push(escapeRegex(template.slice(lastIndex, TEMPLATE_TOKEN_PATTERN.lastIndex)));
      lastIndex = TEMPLATE_TOKEN_PATTERN.lastIndex;
      continue;
    }

    parts.push(escapeRegex(template.slice(lastIndex, match.index)));
    if (seenTokens.has(token)) {
      duplicateTokens.push(token);
    } else {
      seenTokens.add(token);
      tokens.push(token);
    }
    parts.push(`(?<${token}>${FEATURE_SLUG_PATTERN})`);
    lastIndex = TEMPLATE_TOKEN_PATTERN.lastIndex;
  }

  parts.push(escapeRegex(template.slice(lastIndex)));
  parts.push('$');

  return {
    regex: new RegExp(parts.join(''), 'i'),
    tokens,
    duplicateTokens,
    unsupportedTokens,
  };
};

const GIT_BRANCH_DISALLOWED_SEQUENCES = ['..', '@{', '//', '\\'];
const GIT_BRANCH_LITERAL_DISALLOWED_CHARS = new Set(['~', '^', ':', '?', '*', '[']);

const hasDisallowedGitBranchCharacter = (branchName: string): boolean =>
  Array.from(branchName).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f || GIT_BRANCH_LITERAL_DISALLOWED_CHARS.has(character);
  });

export const isValidGitBranchName = (branchName: string): boolean => {
  const normalized = normalizeGitBranchName(branchName);
  if (!normalized) return false;
  if (normalized === '@') return false;
  if (normalized.endsWith('.')) return false;
  if (normalized.endsWith('.lock')) return false;
  if (hasDisallowedGitBranchCharacter(normalized)) return false;
  if (GIT_BRANCH_DISALLOWED_SEQUENCES.some((sequence) => normalized.includes(sequence))) {
    return false;
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0)) return false;
  if (segments.some((segment) => segment.startsWith('.') || segment.endsWith('.lock'))) {
    return false;
  }

  return true;
};

const validateRenderedGitBranchName = (
  label: string,
  branchName: string,
): string[] =>
  isValidGitBranchName(branchName)
    ? []
    : [`${label} must render a valid Git branch name.`];

const validateTemplateDefinition = (params: {
  label: string;
  template: string;
  allowedTokens: string[];
  rendered: string;
  expectedPairs: Array<[string, string]>;
}): string[] => {
  const compiled = compileGitFlowTemplateTokenMatch(
    params.template,
    params.allowedTokens,
  );
  const errors: string[] = [];
  const unsupportedTokens = Array.from(new Set(compiled.unsupportedTokens));

  if (unsupportedTokens.length > 0) {
    errors.push(
      `${params.label} cannot include unsupported tokens: ${unsupportedTokens.join(', ')}.`,
    );
  }
  if (compiled.duplicateTokens.length > 0) {
    errors.push(
      `${params.label} cannot repeat tokens: ${compiled.duplicateTokens.join(', ')}.`,
    );
  }

  errors.push(...validateRenderedGitBranchName(params.label, params.rendered));

  const parsed = compiled.regex.exec(params.rendered);
  if (!parsed) {
    errors.push(`${params.label} must be parseable after rendering.`);
    return errors;
  }

  for (const [token, expectedValue] of params.expectedPairs) {
    if (parsed.groups?.[token] !== expectedValue) {
      errors.push(`${params.label} must preserve ${token} in a parseable way.`);
      break;
    }
  }

  return errors;
};

export const getDefaultProjectGitFlowSettings = (): ProjectGitFlowSettings =>
  normalizeProjectGitFlowSettings({
    baseBranch: readStoredValue(PREF_KEYS.ARCHITECT_GIT_BASE_BRANCH) || DEFAULT_PROJECT_SETTINGS.baseBranch,
    mainBranch: readStoredValue(PREF_KEYS.ARCHITECT_GIT_MAIN_BRANCH) || DEFAULT_PROJECT_SETTINGS.mainBranch,
    planBranchTemplate:
      readStoredValue(PREF_KEYS.ARCHITECT_PLAN_BRANCH_TEMPLATE) || DEFAULT_PROJECT_SETTINGS.planBranchTemplate,
    featureBranchTemplate:
      readStoredValue(PREF_KEYS.ARCHITECT_FEATURE_BRANCH_TEMPLATE) || DEFAULT_PROJECT_SETTINGS.featureBranchTemplate,
    standaloneFeatureBranchTemplate:
      readStoredValue(PREF_KEYS.ARCHITECT_STANDALONE_FEATURE_BRANCH_TEMPLATE) ||
      DEFAULT_PROJECT_SETTINGS.standaloneFeatureBranchTemplate,
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

  if (!normalized.mainBranch) {
    errors.push('Main branch cannot be empty.');
  }

  (Object.keys(TEMPLATE_KEY_BY_BRANCH_TYPE) as GitFlowBranchType[]).forEach((branchType) => {
    const template = getTemplateForBranchType(branchType, normalized);
    errors.push(...validateTemplateForBranchType(branchType, template));
  });

  if (!normalized.standaloneFeatureBranchTemplate.includes('{featureSlug}')) {
    errors.push('Independent feature branch template must include {featureSlug}.');
  }

  errors.push(...validateProjectGitFlowParsing(normalized));

  return errors;
};

export const validateArchitectGitNamingSettings = (settings: ArchitectGitNamingSettings): string[] =>
  validateProjectGitFlowSettings(settings);

export const validateProjectGitFlowParsing = (
  settings?: Partial<ProjectGitFlowSettings> | null,
): string[] => {
  const resolvedSettings = resolveProjectGitFlowSettings(settings);
  const errors: string[] = [];

  const samplePlanSlug = 'checkout-rework';
  const sampleFeatureSlug = 'checkout-api';

  errors.push(
    ...validateTemplateDefinition({
      label: TEMPLATE_LABEL_BY_BRANCH_TYPE.plan,
      template: resolvedSettings.planBranchTemplate,
      allowedTokens: ['planSlug'],
      rendered: renderGitFlowBranchName({
        branchType: 'plan',
        planSlug: samplePlanSlug,
        settings: resolvedSettings,
      }),
      expectedPairs: [['planSlug', samplePlanSlug]],
    }),
  );
  errors.push(
    ...validateTemplateDefinition({
      label: TEMPLATE_LABEL_BY_BRANCH_TYPE.feature,
      template: resolvedSettings.featureBranchTemplate,
      allowedTokens: ['planSlug', 'featureSlug'],
      rendered: renderGitFlowBranchName({
        branchType: 'feature',
        planSlug: samplePlanSlug,
        branchSlug: sampleFeatureSlug,
        settings: resolvedSettings,
      }),
      expectedPairs: [
        ['planSlug', samplePlanSlug],
        ['featureSlug', sampleFeatureSlug],
      ],
    }),
  );
  errors.push(
    ...validateTemplateDefinition({
      label: 'Independent feature branch template',
      template: resolvedSettings.standaloneFeatureBranchTemplate,
      allowedTokens: ['featureSlug'],
      rendered: renderStandaloneFeatureBranchName({
        featureSlug: sampleFeatureSlug,
        settings: resolvedSettings,
      }),
      expectedPairs: [['featureSlug', sampleFeatureSlug]],
    }),
  );

  return errors;
};

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

  return normalizeGitBranchName(
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

export const toStandaloneFeatureBranchName = (
  featureSlug: string,
  settings?: Partial<ProjectGitFlowSettings> | null
): string => {
  const resolvedSettings = resolveProjectGitFlowSettings(settings);
  const safeBranchSlug = sanitizeBranchSlugInput(featureSlug, 'feature');
  return normalizeGitBranchName(
    replaceTemplateTokens(resolvedSettings.standaloneFeatureBranchTemplate, {
      featureSlug: safeBranchSlug,
    }),
    `feature/${safeBranchSlug}`
  );
};

export const renderStandaloneFeatureBranchName = (params: {
  featureSlug: string;
  settings?: Partial<ProjectGitFlowSettings> | null;
}): string => toStandaloneFeatureBranchName(params.featureSlug, params.settings);

export const getProjectBaseBranch = (settings?: Partial<ProjectGitFlowSettings> | null): string =>
  resolveProjectGitFlowSettings(settings).baseBranch;

export const getProjectMainBranch = (settings?: Partial<ProjectGitFlowSettings> | null): string =>
  resolveProjectGitFlowSettings(settings).mainBranch;

export const shouldSyncTargetBranchBeforeFinish = (): boolean =>
  getArchitectGitNamingSettings().syncTargetBeforeFinish;
