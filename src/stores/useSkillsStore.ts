import { create } from 'zustand';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';
import { formatScriptResult, formatSkillActivationBlock } from '../services/skills/activation';
import {
  findEnabledSkillByName,
  getEnabledLoadableSkills,
  getRunnableSkillIds,
} from '../services/skills/availability';
import {
  getRefSkillIdentity,
  getSkillLocationUri,
  skillIdentityChanged,
} from '../services/skills/identity';
import { normalizeSkillMentionName, parseMentionNames } from '../services/skills/mentions';
import {
  DEFAULT_SKILL_SETTINGS,
  migrateLegacySkillSettings,
  normalizeSkillSettings,
  readStoredSkillSettings,
  writeStoredSkillSettings,
} from '../services/skills/settings';
import { useAppStore } from './useAppStore';
import type {
  ContextReference,
  PersistedContextReference,
  SkillActivation,
  SkillManifest,
  SkillProjectRoot,
  SkillScriptRunRequest,
  SkillSettings,
} from '../types';

export interface SkillTurnPreparation {
  activatedSkills: SkillActivation[];
  systemInstructionBlocks: string[];
  explicitSkillIds: string[];
  warnings: string[];
  toolsAvailable: boolean;
}

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
  getRunnableSkillIds: (options?: { includeShadowed?: boolean }) => string[];
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

  getEnabledLoadableSkills: (options) =>
    getEnabledLoadableSkills(get().skills, get().getSkillSettings, options),

  getEnabledSkills: () => get().getEnabledLoadableSkills(),

  getRunnableSkillIds: (options) =>
    getRunnableSkillIds(get().skills, get().getSkillSettings, options),

  findEnabledSkillByName: (name) => {
    return findEnabledSkillByName(
      name,
      get().getEnabledLoadableSkills({ includeShadowed: true }),
      get().getEnabledSkills(),
    );
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
      const expectedIdentity = getRefSkillIdentity(ref);
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
      if (skillIdentityChanged(skill, expectedIdentity)) {
        warnings.push(`Skill ${ref.title} changed location. Re-select it from the Skills menu.`);
        continue;
      }
      addSkill(skill);
    }

    const enabledByNormalizedName = new Map<string, SkillManifest[]>();
    for (const skill of effectiveEnabledSkills) {
      const key = normalizeSkillMentionName(skill.name);
      enabledByNormalizedName.set(key, [...(enabledByNormalizedName.get(key) ?? []), skill]);
    }
    for (const mention of parseMentionNames(content)) {
      const key = normalizeSkillMentionName(mention);
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
    const cachedLocationUri = cachedSkill ? getSkillLocationUri(cachedSkill) : undefined;
    const cachedActivation = conversationId
      ? get().activationsByConversationId[conversationId]?.find((item) =>
        item.skillId === skillId &&
        item.body &&
        (
          (cachedSkill?.contentHash && item.contentHash === cachedSkill.contentHash) ||
          (!cachedSkill?.contentHash && cachedLocationUri && item.locationUri === cachedLocationUri)
        )
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
      locationUri: getSkillLocationUri(response.skill),
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
