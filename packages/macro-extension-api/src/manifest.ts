export type MacroExtensionViewKind = 'tree' | 'graph' | 'details' | 'table';
export type MacroExtensionViewLocation = 'leftPanel' | 'centerPanel' | 'rightPanel';
export type MacroExtensionRisk = 'read' | 'write' | 'network' | 'system';

export interface MacroExtensionModeContribution {
  id: string;
  label: string;
  icon?: string;
  layout: Partial<Record<'left' | 'center' | 'right', string>>;
  composer?: string;
  conversation?: {
    enabled?: boolean;
  };
  toolPolicy?: {
    allowedToolIds?: string[];
    enforceMacroOnlyWrites?: boolean;
  };
}

export interface MacroExtensionViewContribution {
  id: string;
  title: string;
  kind: MacroExtensionViewKind;
  location: MacroExtensionViewLocation;
  src?: string;
}

export interface MacroExtensionComposerMode {
  id: string;
  label: string;
  prompt?: string;
  tools?: string[];
}

export interface MacroExtensionComposerContribution {
  id: string;
  target?: string;
  style?: 'floating' | 'inline' | string;
  placeholder?: string;
  defaultMode?: string;
  modes?: MacroExtensionComposerMode[];
}

export interface MacroExtensionCommandContribution {
  id: string;
  title: string;
}

export interface MacroExtensionToolContribution {
  id: string;
  description: string;
  parameters?: unknown;
  risk?: MacroExtensionRisk | string;
}

export interface MacroExtensionManifest {
  id: string;
  name: string;
  version: string;
  publisher?: string;
  description?: string;
  main: string;
  activationEvents?: string[];
  extensionKind?: string[];
  engines?: {
    macro?: string;
    [key: string]: unknown;
  };
  contributes?: {
    modes?: MacroExtensionModeContribution[];
    views?: MacroExtensionViewContribution[];
    composers?: MacroExtensionComposerContribution[];
    commands?: MacroExtensionCommandContribution[];
    tools?: MacroExtensionToolContribution[];
  };
  permissions?: Record<string, string[]>;
  untrustedWorkspaces?: {
    supported?: boolean;
  };
  [key: string]: unknown;
}

export interface MacroExtensionManifestValidation {
  valid: boolean;
  errors: string[];
}

const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const CONTRIBUTION_ID_PATTERN = /^[a-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ALLOWED_PERMISSION_SCOPES = new Set([
  'workspace',
  'ui',
  'ai',
  'git',
  'storage',
  'commands',
  'tools',
  'implement',
  'notifications',
]);
const ALLOWED_VIEW_KINDS = new Set<MacroExtensionViewKind>(['tree', 'graph', 'details', 'table']);
const ALLOWED_VIEW_LOCATIONS = new Set<MacroExtensionViewLocation>([
  'leftPanel',
  'centerPanel',
  'rightPanel',
]);

export const parseMacroExtensionManifest = (json: string): MacroExtensionManifest => {
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Macro extension manifest must be a JSON object.');
  }
  return parsed as MacroExtensionManifest;
};

export const normalizeMacroExtensionPackagePath = (rawPath: string): string => {
  const decoded = decodeURIComponent(String(rawPath ?? '').trim()).replace(/\\/g, '/');
  const withoutDot = decoded.replace(/^\.\/+/, '');
  if (!withoutDot) {
    throw new Error('Package path must not be empty.');
  }
  if (/^(?:[a-zA-Z]:\/|\/|\/\/)/.test(withoutDot)) {
    throw new Error(`Package path must be relative: ${rawPath}`);
  }
  const parts = withoutDot.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    throw new Error(`Package path traversal is not allowed: ${rawPath}`);
  }
  return parts.join('/');
};

export const validateMacroExtensionManifest = (
  manifest: MacroExtensionManifest,
): MacroExtensionManifestValidation => {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['Manifest must be a JSON object.'] };
  }

  requireString(manifest.id, 'id', errors);
  requireString(manifest.name, 'name', errors);
  requireString(manifest.version, 'version', errors);
  requireString(manifest.main, 'main', errors);

  if (typeof manifest.id === 'string' && !EXTENSION_ID_PATTERN.test(manifest.id)) {
    errors.push('Manifest id must be a namespaced id such as "publisher.extension".');
  }
  if (typeof manifest.version === 'string' && !SEMVER_PATTERN.test(manifest.version)) {
    errors.push('Manifest version must be semver.');
  }
  if (typeof manifest.main === 'string') {
    try {
      normalizeMacroExtensionPackagePath(manifest.main);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (manifest.engines?.macro !== undefined && typeof manifest.engines.macro !== 'string') {
    errors.push('engines.macro must be a string when provided.');
  }

  const contributes = manifest.contributes ?? {};
  validateArray(contributes.modes, 'contributes.modes', errors);
  validateArray(contributes.views, 'contributes.views', errors);
  validateArray(contributes.composers, 'contributes.composers', errors);
  validateArray(contributes.commands, 'contributes.commands', errors);
  validateArray(contributes.tools, 'contributes.tools', errors);
  validateStringArray(manifest.activationEvents, 'activationEvents', errors);

  validateContributionIds(contributes.modes, 'mode', manifest.id, errors);
  validateContributionIds(contributes.views, 'view', manifest.id, errors);
  validateContributionIds(contributes.composers, 'composer', manifest.id, errors);
  validateContributionIds(contributes.commands, 'command', manifest.id, errors);
  validateContributionIds(contributes.tools, 'tool', manifest.id, errors);
  validateDuplicates(manifest.activationEvents ?? [], 'activationEvents', errors);

  for (const mode of contributes.modes ?? []) {
    if (!mode || typeof mode !== 'object') {
      errors.push('Mode contributions must be objects.');
      continue;
    }
    requireString(mode.label, `mode ${mode.id || '<unknown>'}.label`, errors);
    if (!mode.layout || typeof mode.layout !== 'object' || Array.isArray(mode.layout)) {
      errors.push(`Mode "${mode.id}" must define a layout object.`);
    }
    const allowedToolIds = mode.toolPolicy?.allowedToolIds;
    validateStringArray(allowedToolIds, `mode ${mode.id}.toolPolicy.allowedToolIds`, errors);
    validateDuplicates(allowedToolIds ?? [], `mode ${mode.id} allowed tools`, errors);
  }

  for (const view of contributes.views ?? []) {
    if (!view || typeof view !== 'object') {
      errors.push('View contributions must be objects.');
      continue;
    }
    requireString(view.title, `view ${view.id || '<unknown>'}.title`, errors);
    if (!ALLOWED_VIEW_KINDS.has(view.kind)) {
      errors.push(`View "${view.id}" has unsupported kind "${String(view.kind)}".`);
    }
    if (!ALLOWED_VIEW_LOCATIONS.has(view.location)) {
      errors.push(`View "${view.id}" has unsupported location "${String(view.location)}".`);
    }
    if (typeof view.src === 'string') {
      validateExtensionUrl(view.src, manifest.id, errors);
    }
  }

  for (const composer of contributes.composers ?? []) {
    if (!composer || typeof composer !== 'object') {
      errors.push('Composer contributions must be objects.');
      continue;
    }
    validateArray(composer.modes, `composer ${composer.id}.modes`, errors);
    validateContributionIds(composer.modes, `composer ${composer.id} mode`, manifest.id, errors, {
      allowSimpleId: true,
    });
    for (const mode of composer.modes ?? []) {
      requireString(mode.label, `composer ${composer.id} mode ${mode.id}.label`, errors);
      validateStringArray(mode.tools, `composer ${composer.id} mode ${mode.id}.tools`, errors);
      validateDuplicates(mode.tools ?? [], `composer ${composer.id} mode ${mode.id} tools`, errors);
    }
  }

  for (const command of contributes.commands ?? []) {
    requireString(command?.title, `command ${command?.id || '<unknown>'}.title`, errors);
  }
  for (const tool of contributes.tools ?? []) {
    requireString(tool?.description, `tool ${tool?.id || '<unknown>'}.description`, errors);
  }

  if (manifest.permissions !== undefined) {
    if (!manifest.permissions || typeof manifest.permissions !== 'object' || Array.isArray(manifest.permissions)) {
      errors.push('permissions must be an object when provided.');
    } else {
      for (const [scope, grants] of Object.entries(manifest.permissions)) {
        if (!ALLOWED_PERMISSION_SCOPES.has(scope)) {
          errors.push(`Unknown permission scope "${scope}".`);
        }
        validateStringArray(grants, `permissions.${scope}`, errors);
        validateDuplicates(grants ?? [], `permissions.${scope}`, errors);
      }
    }
  }

  return { valid: errors.length === 0, errors };
};

const requireString = (value: unknown, field: string, errors: string[]): void => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`Manifest field "${field}" must be a non-empty string.`);
  }
};

const validateArray = (value: unknown, field: string, errors: string[]): void => {
  if (value !== undefined && !Array.isArray(value)) {
    errors.push(`${field} must be an array when provided.`);
  }
};

const validateStringArray = (value: unknown, field: string, errors: string[]): void => {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array when provided.`);
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`${field}[${index}] must be a non-empty string.`);
    }
  });
};

const validateDuplicates = (values: string[], label: string, errors: string[]): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      errors.push(`Duplicate ${label} entry "${value}".`);
    }
    seen.add(value);
  }
};

const validateContributionIds = (
  items: Array<{ id?: unknown }> | undefined,
  label: string,
  extensionId: string,
  errors: string[],
  options: { allowSimpleId?: boolean } = {},
): void => {
  if (!Array.isArray(items)) return;
  const ids: string[] = [];
  for (const item of items) {
    const id = item?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      errors.push(`${label} contributions must have non-empty string ids.`);
      continue;
    }
    ids.push(id);
    const simpleId = /^[a-z][a-z0-9-]*$/.test(id);
    if (options.allowSimpleId && simpleId) {
      continue;
    }
    if (!CONTRIBUTION_ID_PATTERN.test(id)) {
      errors.push(`${label} id "${id}" must be namespaced.`);
    }
    if (extensionId && CONTRIBUTION_ID_PATTERN.test(id) && !id.startsWith(`${extensionId}.`) && id !== extensionId) {
      errors.push(`${label} id "${id}" must be namespaced under extension id "${extensionId}".`);
    }
  }
  validateDuplicates(ids, `${label} id`, errors);
};

const validateExtensionUrl = (src: string, extensionId: string, errors: string[]): void => {
  const match = src.match(/^extension:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    errors.push(`Invalid extension URL "${src}".`);
    return;
  }
  const [, urlExtensionId, rawPath] = match;
  if (urlExtensionId !== extensionId) {
    errors.push(`Extension URL "${src}" must use extension id "${extensionId}".`);
  }
  try {
    normalizeMacroExtensionPackagePath(rawPath ?? '');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
};
