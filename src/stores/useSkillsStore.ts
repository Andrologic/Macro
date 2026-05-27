import { create } from 'zustand';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';
import { useAppStore } from './useAppStore';
import type {
  ContextReference,
  PersistedContextReference,
  SkillActivation,
  SkillManifest,
  SkillProjectRoot,
  SkillScriptRunRequest,
  SkillScriptRunResult,
  SkillSettings,
} from '../types';

const SKILL_SETTINGS_STORAGE_KEY = 'macro_skill_settings';
const SKILL_SETTINGS_VERSION = 1;

type StoredSkillSettings = {
  version: number;
  skills: Record<string, SkillSettings>;
};

const DEFAULT_SKILL_SETTINGS: SkillSettings = {
  enabled: false,
  trusted: false,
  scriptsEnabled: false,
};

export interface SkillTurnPreparation {
  activatedSkills: SkillActivation[];
  systemInstructionBlocks: string[];
  explicitSkillIds: string[];
  warnings: string[];
  toolsAvailable: boolean;
}

const normalizeSkillSettings = (value: unknown): SkillSettings => {
  const candidate = value && typeof value === 'object' ? value as Partial<SkillSettings> : {};
  const trusted = candidate.trusted === true;
  return {
    enabled: candidate.enabled === true,
    trusted,
    scriptsEnabled: trusted && candidate.scriptsEnabled === true,
  };
};

const readStoredSkillSettings = (): Record<string, SkillSettings> => {
  try {
    const raw = localStorage.getItem(SKILL_SETTINGS_STORAGE_KEY);
    if (!raw || raw === 'undefined') return {};
    const parsed = JSON.parse(raw) as Partial<StoredSkillSettings>;
    const skills = parsed.skills && typeof parsed.skills === 'object' ? parsed.skills : {};
    return Object.fromEntries(
      Object.entries(skills).map(([id, settings]) => [id, normalizeSkillSettings(settings)])
    );
  } catch {
    return {};
  }
};

const writeStoredSkillSettings = (settingsBySkillId: Record<string, SkillSettings>): void => {
  localStorage.setItem(
    SKILL_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      version: SKILL_SETTINGS_VERSION,
      skills: settingsBySkillId,
    } satisfies StoredSkillSettings)
  );
};

const normalizeSkillNameForId = (value: string, fallback = 'skill'): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
};

const legacySkillIdFor = (skill: SkillManifest): string => {
  const normalizedName = normalizeSkillNameForId(skill.name);
  return skill.source.kind === 'project'
    ? `project:${skill.source.projectId ?? 'unknown'}:${normalizedName}`
    : `global:${normalizedName}`;
};

const migrateLegacySkillSettings = (
  settingsBySkillId: Record<string, SkillSettings>,
  skills: SkillManifest[],
): Record<string, SkillSettings> => {
  const next = { ...settingsBySkillId };
  const skillsByLegacyId = new Map<string, SkillManifest[]>();
  for (const skill of skills) {
    const legacyId = legacySkillIdFor(skill);
    skillsByLegacyId.set(legacyId, [...(skillsByLegacyId.get(legacyId) ?? []), skill]);
  }

  let changed = false;
  for (const [legacyId, settings] of Object.entries(settingsBySkillId)) {
    const matches = skillsByLegacyId.get(legacyId) ?? [];
    const effectiveMatches = matches.filter((skill) => !skill.shadowedBySkillId);
    const migrationMatches = effectiveMatches.length === 1 ? effectiveMatches : matches;
    if (migrationMatches.length !== 1) continue;
    const [skill] = migrationMatches;
    if (!skill || skill.id === legacyId) continue;
    if (!next[skill.id]) {
      next[skill.id] = settings;
    }
    delete next[legacyId];
    changed = true;
  }

  if (changed) {
    writeStoredSkillSettings(next);
  }
  return next;
};

const getProjectRootsFromAppState = (): SkillProjectRoot[] => {
  const appState = useAppStore.getState();
  const projects = appState.projectGroups.flatMap((group) => group.projects);
  const roots = projects
    .map((project) => ({
      projectId: project.id,
      projectName: project.name,
      path: project.path,
    }))
    .filter((project) => project.path.trim().length > 0);
  return Array.from(new Map(roots.map((root) => [root.projectId, root])).values());
};

const formatSkillResources = (skill: SkillManifest): string => {
  const resources = skill.resources.map((resource) =>
    `- ${resource.path} (${resource.kind}, ${resource.sizeBytes} bytes)`
  );
  return resources.join('\n') || '- None discovered.';
};

const formatSkillScripts = (skill: SkillManifest): string => {
  const scripts = skill.scripts.map((script) =>
    `- ${script.path} (${script.sizeBytes} bytes)`
  );
  return scripts.join('\n') || '- None discovered.';
};

const escapeSkillAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const formatSkillSource = (skill: SkillManifest): string =>
  `${skill.source.kind}/${skill.source.namespace ?? 'agents'}`;

const isSkillLoadable = (skill: SkillManifest): boolean => skill.isValid;

const isSkillEffective = (skill: SkillManifest): boolean => !skill.shadowedBySkillId;

const formatSkillActivationBlock = (
  skill: SkillManifest,
  body: string,
  alreadyLoaded: boolean,
): string => {
  const location = skill.location ?? {
    kind: 'local' as const,
    uri: skill.rootPath,
  };
  const attributes = [
    `name="${escapeSkillAttribute(skill.name)}"`,
    `id="${escapeSkillAttribute(skill.id)}"`,
    `source="${escapeSkillAttribute(formatSkillSource(skill))}"`,
    `location_kind="${escapeSkillAttribute(location.kind)}"`,
    `location_uri="${escapeSkillAttribute(location.uri)}"`,
    skill.contentHash ? `content_hash="${escapeSkillAttribute(skill.contentHash)}"` : '',
    alreadyLoaded ? 'already_loaded="true"' : '',
  ].filter(Boolean).join(' ');

  const headerLines = [
    `# Skill: ${skill.name}`,
    '',
    skill.description,
    '',
    `Source: ${formatSkillSource(skill)}`,
    `Location: ${location.kind}:${location.uri}`,
    skill.compatibility ? `Compatibility: ${skill.compatibility}` : '',
    skill.license ? `License: ${skill.license}` : '',
    skill.specCompliant === false
      ? 'Spec compliance: warnings present; Macro loaded this skill leniently.'
      : 'Spec compliance: compliant or not reported.',
    skill.allowedTools
      ? `Allowed tools requested by skill (advisory only): ${skill.allowedTools}`
      : '',
    skill.shadowedBySkillId
      ? `Shadowed by: ${skill.shadowedBySkillId}. This exact id was selected explicitly.`
      : '',
  ].filter(Boolean);

  return [
    `<skill_content ${attributes}>`,
    ...headerLines,
    '',
    '## Instructions',
    body.trim() || '(No body instructions.)',
    '',
    '## Bundled Resources',
    formatSkillResources(skill),
    '',
    '## Bundled Scripts',
    formatSkillScripts(skill),
    '',
    'Resources, assets, and scripts are listed only. They are not loaded by activation. Use skill_read_resource for listed resources/assets and skill_run_script only when explicitly useful and allowed by Macro policy.',
    '</skill_content>',
  ].join('\n');
};

const formatScriptResult = (result: SkillScriptRunResult): string => [
  `skill_id: ${result.skillId}`,
  `script_path: ${result.scriptPath}`,
  `exit_code: ${result.exitCode ?? 'none'}`,
  `timed_out: ${result.timedOut ? 'true' : 'false'}`,
  result.truncated ? 'output_truncated: true' : '',
  result.stdout ? `\nSTDOUT:\n${result.stdout}` : '',
  result.stderr ? `\nSTDERR:\n${result.stderr}` : '',
].filter(Boolean).join('\n');

const parseMentionNames = (content: string): string[] => {
  const dollarMentions = Array.from(content.matchAll(/\$([A-Za-z0-9_:-]{1,120})/g))
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
  const bracketMentions = Array.from(content.matchAll(/\[skill:\s*([^\]]+)\]/gi))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  return [...dollarMentions, ...bracketMentions];
};

const isSkillContextRef = (
  ref: ContextReference | PersistedContextReference,
): ref is (ContextReference | PersistedContextReference) & { kind: 'skill' } =>
  ref.kind === 'skill';

interface SkillsStore {
  skills: SkillManifest[];
  settingsBySkillId: Record<string, SkillSettings>;
  activationsByConversationId: Record<string, SkillActivation[] | undefined>;
  isLoading: boolean;
  saving: boolean;
  lastError: string | null;
  loadSettings: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  installSkillFromLocalPath: (sourcePath: string) => Promise<void>;
  updateSkillSettings: (skillId: string, settings: Partial<SkillSettings>) => void;
  setSkillEnabled: (skillId: string, enabled: boolean) => void;
  setSkillTrusted: (skillId: string, trusted: boolean) => void;
  setSkillScriptsEnabled: (skillId: string, scriptsEnabled: boolean) => void;
  getSkillSettings: (skillId: string) => SkillSettings;
  getSkillById: (skillId: string) => SkillManifest | null;
  getEnabledSkills: () => SkillManifest[];
  getEnabledLoadableSkills: (options?: { includeShadowed?: boolean }) => SkillManifest[];
  getRunnableSkillIds: () => string[];
  findEnabledSkillByName: (name: string) => SkillManifest | null;
  resolveEnabledSkillMentions: (content: string) => SkillManifest[];
  prepareSkillsForTurn: (params: {
    conversationId: string;
    content: string;
    contextRefs?: Array<ContextReference | PersistedContextReference>;
    toolsAvailable: boolean;
  }) => Promise<SkillTurnPreparation>;
  activateSkill: (skillId: string, conversationId?: string) => Promise<string>;
  readSkillResource: (skillId: string, resourcePath: string) => Promise<string>;
  runSkillScript: (request: SkillScriptRunRequest) => Promise<string>;
}

export const useSkillsStore = create<SkillsStore>((set, get) => ({
  skills: [],
  settingsBySkillId: {},
  activationsByConversationId: {},
  isLoading: false,
  saving: false,
  lastError: null,

  loadSettings: async () => {
    set({ isLoading: true, lastError: null });
    try {
      const settingsBySkillId = readStoredSkillSettings();
      const response = await services.listSkills({ projectRoots: getProjectRootsFromAppState() });
      const migratedSettings = migrateLegacySkillSettings(settingsBySkillId, response.skills);
      set({
        skills: response.skills,
        settingsBySkillId: migratedSettings,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, lastError: toServiceError(error).message });
    }
  },

  refreshSkills: async () => {
    set({ isLoading: true, lastError: null });
    try {
      const response = await services.listSkills({ projectRoots: getProjectRootsFromAppState() });
      const migratedSettings = migrateLegacySkillSettings(get().settingsBySkillId, response.skills);
      set({ skills: response.skills, settingsBySkillId: migratedSettings, isLoading: false });
    } catch (error) {
      set({ isLoading: false, lastError: toServiceError(error).message });
    }
  },

  installSkillFromLocalPath: async (sourcePath) => {
    set({ saving: true, lastError: null });
    try {
      const installed = await services.installSkillFromLocalPath({ sourcePath });
      const nextSettings = {
        ...get().settingsBySkillId,
        [installed.id]: { enabled: true, trusted: false, scriptsEnabled: false },
      };
      writeStoredSkillSettings(nextSettings);
      const response = await services.listSkills({ projectRoots: getProjectRootsFromAppState() });
      set({
        skills: response.skills,
        settingsBySkillId: nextSettings,
        saving: false,
      });
    } catch (error) {
      set({ saving: false, lastError: toServiceError(error).message });
    }
  },

  updateSkillSettings: (skillId, settings) => {
    set((state) => {
      const current = state.settingsBySkillId[skillId] ?? DEFAULT_SKILL_SETTINGS;
      const next = normalizeSkillSettings({
        ...current,
        ...settings,
        scriptsEnabled: settings.trusted === false ? false : settings.scriptsEnabled ?? current.scriptsEnabled,
      });
      const settingsBySkillId = {
        ...state.settingsBySkillId,
        [skillId]: next,
      };
      writeStoredSkillSettings(settingsBySkillId);
      return { settingsBySkillId };
    });
  },

  setSkillEnabled: (skillId, enabled) => {
    get().updateSkillSettings(skillId, { enabled });
  },

  setSkillTrusted: (skillId, trusted) => {
    get().updateSkillSettings(skillId, {
      trusted,
      scriptsEnabled: trusted ? get().getSkillSettings(skillId).scriptsEnabled : false,
    });
  },

  setSkillScriptsEnabled: (skillId, scriptsEnabled) => {
    const current = get().getSkillSettings(skillId);
    get().updateSkillSettings(skillId, {
      scriptsEnabled: current.trusted && scriptsEnabled,
    });
  },

  getSkillSettings: (skillId) => get().settingsBySkillId[skillId] ?? DEFAULT_SKILL_SETTINGS,

  getSkillById: (skillId) => get().skills.find((skill) => skill.id === skillId) ?? null,

  getEnabledLoadableSkills: (options) => get().skills.filter((skill) => {
    if (!isSkillLoadable(skill)) return false;
    if (!get().getSkillSettings(skill.id).enabled) return false;
    return options?.includeShadowed === true || isSkillEffective(skill);
  }),

  getEnabledSkills: () => get().getEnabledLoadableSkills(),

  getRunnableSkillIds: () => get().getEnabledLoadableSkills({ includeShadowed: true })
    .filter((skill) => {
      const settings = get().getSkillSettings(skill.id);
      return settings.trusted && settings.scriptsEnabled && skill.scripts.length > 0;
    })
    .map((skill) => skill.id),

  findEnabledSkillByName: (name) => {
    const normalized = name.trim().replace(/^\$/, '').toLowerCase();
    if (!normalized) return null;
    const exactIdMatch = get()
      .getEnabledLoadableSkills({ includeShadowed: true })
      .find((skill) => skill.id.toLowerCase() === normalized);
    if (exactIdMatch) return exactIdMatch;
    const matches = get().getEnabledSkills().filter((skill) =>
      skill.name.toLowerCase() === normalized
    );
    return matches.length === 1 ? matches[0] ?? null : null;
  },

  resolveEnabledSkillMentions: (content) => {
    const resolved = parseMentionNames(content)
      .map((mention) => get().findEnabledSkillByName(mention))
      .filter((skill): skill is SkillManifest => Boolean(skill));
    return Array.from(new Map(resolved.map((skill) => [skill.id, skill])).values());
  },

  prepareSkillsForTurn: async ({ conversationId, content, contextRefs = [], toolsAvailable }) => {
    const state = get();
    const enabledSkills = state.getEnabledLoadableSkills({ includeShadowed: true });
    const effectiveEnabledSkills = state.getEnabledSkills();
    const enabledSkillsById = new Map(enabledSkills.map((skill) => [skill.id, skill]));
    const allSkillsById = new Map(state.skills.map((skill) => [skill.id, skill]));
    const selectedSkills: SkillManifest[] = [];
    const warnings: string[] = [];
    const seenIds = new Set<string>();

    const addSkill = (skill: SkillManifest) => {
      if (seenIds.has(skill.id)) return;
      seenIds.add(skill.id);
      selectedSkills.push(skill);
    };

    for (const ref of contextRefs.filter(isSkillContextRef)) {
      const persistedPath = 'skillFilePath' in ref ? ref.skillFilePath : undefined;
      const refData = 'data' in ref ? ref.data : undefined;
      const dataPath =
        refData && 'skillFilePath' in refData ? refData.skillFilePath : undefined;
      const expectedPath = persistedPath ?? dataPath;
      const skill = enabledSkillsById.get(ref.id);
      const discovered = allSkillsById.get(ref.id);
      if (!skill) {
        warnings.push(
          discovered
            ? `Skill ${ref.title} is disabled. Enable it in Settings > Skills before using it.`
            : `Skill ${ref.title} is no longer available. Refresh Skills or remove it from the composer.`,
        );
        continue;
      }
      if (expectedPath && skill.skillFilePath !== expectedPath) {
        warnings.push(`Skill ${ref.title} changed location. Re-select it from the Skills menu.`);
        continue;
      }
      addSkill(skill);
    }

    const enabledByNormalizedName = new Map<string, SkillManifest[]>();
    for (const skill of effectiveEnabledSkills) {
      const key = skill.name.toLowerCase();
      enabledByNormalizedName.set(key, [...(enabledByNormalizedName.get(key) ?? []), skill]);
    }
    for (const mention of parseMentionNames(content)) {
      const key = mention.trim().replace(/^\$/, '').toLowerCase();
      if (!key) continue;
      const matches = enabledByNormalizedName.get(key) ?? [];
      if (matches.length === 1 && matches[0]) {
        addSkill(matches[0]);
      } else if (matches.length > 1) {
        warnings.push(
          `Skill "${mention}" is ambiguous. Select the exact skill from the Skills menu.`,
        );
      }
    }

    const systemInstructionBlocks: string[] = [];
    const activatedSkills: SkillActivation[] = [];
    for (const skill of selectedSkills) {
      try {
        const block = await state.activateSkill(skill.id, conversationId);
        systemInstructionBlocks.push(block);
        const activation = get().activationsByConversationId[conversationId]
          ?.find((item) => item.skillId === skill.id);
        if (activation) {
          activatedSkills.push(activation);
        }
      } catch (error) {
        warnings.push(`Skill ${skill.name} could not be loaded: ${toServiceError(error).message}`);
      }
    }

    return {
      activatedSkills,
      systemInstructionBlocks,
      explicitSkillIds: selectedSkills.map((skill) => skill.id),
      warnings,
      toolsAvailable,
    };
  },

  activateSkill: async (skillId, conversationId) => {
    const settings = get().getSkillSettings(skillId);
    if (!settings.enabled) {
      return `Skill ${skillId} is disabled. Enable it in Settings > Skills before using it.`;
    }
    const cachedSkill = get().getSkillById(skillId);
    const cachedActivation = conversationId
      ? get().activationsByConversationId[conversationId]?.find((item) =>
        item.skillId === skillId &&
        cachedSkill?.contentHash &&
        item.contentHash === cachedSkill.contentHash &&
        item.body
      )
      : null;
    if (cachedSkill && cachedActivation) {
      return formatSkillActivationBlock(cachedSkill, cachedActivation.body, true);
    }
    const response = await services.getSkill({
      skillId,
      projectRoots: getProjectRootsFromAppState(),
    });
    if (!response.skill.isValid) {
      return `Skill ${skillId} is invalid: ${response.skill.validationErrors.join(' ')}`;
    }
    const activation: SkillActivation = {
      skillId,
      activatedAt: new Date().toISOString(),
      body: response.body,
      contentHash: response.skill.contentHash,
      skillFilePath: response.skill.skillFilePath,
    };
    if (conversationId) {
      set((state) => ({
        activationsByConversationId: {
          ...state.activationsByConversationId,
          [conversationId]: [
            ...(state.activationsByConversationId[conversationId] ?? []).filter(
              (item) => item.skillId !== skillId
            ),
            activation,
          ],
        },
      }));
    }
    return formatSkillActivationBlock(response.skill, response.body, false);
  },

  readSkillResource: async (skillId, resourcePath) => {
    const settings = get().getSkillSettings(skillId);
    if (!settings.enabled) {
      return `Skill ${skillId} is disabled.`;
    }
    const skill = get().getSkillById(skillId);
    if (skill && !skill.isValid) {
      return `Skill ${skillId} is invalid: ${skill.validationErrors.join(' ')}`;
    }
    const response = await services.readSkillResource({
      skillId,
      resourcePath,
      projectRoots: getProjectRootsFromAppState(),
    });
    return response.content;
  },

  runSkillScript: async (request) => {
    const settings = get().getSkillSettings(request.skillId);
    if (!settings.enabled) {
      return `Skill ${request.skillId} is disabled.`;
    }
    if (!settings.trusted || !settings.scriptsEnabled) {
      return `Skill script execution is disabled for ${request.skillId}. Trust the skill and enable scripts in Settings > Skills.`;
    }
    const skill = get().getSkillById(request.skillId);
    if (skill && !skill.isValid) {
      return `Skill ${request.skillId} is invalid: ${skill.validationErrors.join(' ')}`;
    }
    const workspacePath = useAppStore.getState().selectedProjectId
      ? useAppStore.getState().getProjectById(useAppStore.getState().selectedProjectId!)?.path
      : null;
    const result = await services.runSkillScript({
      ...request,
      projectRoots: getProjectRootsFromAppState(),
      workspacePath,
    });
    return formatScriptResult(result);
  },
}));
