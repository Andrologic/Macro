import { create } from 'zustand';
import { services } from '../services';
import { toServiceError } from '../services/contracts/errors';
import { useAppStore } from './useAppStore';
import type {
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
  const resources = skill.resources.map((resource) => `- ${resource.path} (${resource.kind})`);
  const scripts = skill.scripts.map((script) => `- ${script.path} (script)`);
  return [...resources, ...scripts].join('\n') || 'No bundled resources discovered.';
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
  findEnabledSkillByName: (name: string) => SkillManifest | null;
  resolveEnabledSkillMentions: (content: string) => SkillManifest[];
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
      set({
        skills: response.skills,
        settingsBySkillId,
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
      set({ skills: response.skills, isLoading: false });
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

  getEnabledSkills: () => get().skills.filter(
    (skill) => skill.isValid && get().getSkillSettings(skill.id).enabled
  ),

  findEnabledSkillByName: (name) => {
    const normalized = name.trim().replace(/^\$/, '').toLowerCase();
    if (!normalized) return null;
    const matches = get().getEnabledSkills().filter((skill) =>
      skill.name.toLowerCase() === normalized || skill.id.toLowerCase().endsWith(`:${normalized}`)
    );
    return matches[0] ?? null;
  },

  resolveEnabledSkillMentions: (content) => {
    const dollarMentions = Array.from(content.matchAll(/\$([A-Za-z0-9_-]{1,80})/g))
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value));
    const bracketMentions = Array.from(content.matchAll(/\[skill:\s*([^\]]+)\]/gi))
      .map((match) => match[1]?.trim())
      .filter((value): value is string => Boolean(value));
    const mentions = [...dollarMentions, ...bracketMentions];
    const resolved = mentions
      .map((mention) => get().findEnabledSkillByName(mention))
      .filter((skill): skill is SkillManifest => Boolean(skill));
    return Array.from(new Map(resolved.map((skill) => [skill.id, skill])).values());
  },

  activateSkill: async (skillId, conversationId) => {
    const settings = get().getSkillSettings(skillId);
    if (!settings.enabled) {
      return `Skill ${skillId} is disabled. Enable it in Settings > Skills before using it.`;
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
    return [
      `# Skill: ${response.skill.name}`,
      '',
      response.skill.description,
      '',
      '## Instructions',
      response.body.trim(),
      '',
      '## Bundled Resources',
      formatSkillResources(response.skill),
    ].join('\n');
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
