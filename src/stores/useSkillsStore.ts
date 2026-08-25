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
  isSkillTrustCurrent,
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
  SkillLocationOpenRequest,
  SkillPermissionSnapshot,
  SkillProjectRoot,
  SkillScriptRunRequest,
  SkillSettings,
  SkillTemplateCreateRequest,
} from '../types';

export interface SkillTurnPreparation {
  activatedSkills: SkillActivation[];
  systemInstructionBlocks: string[];
  explicitSkillIds: string[];
  warnings: string[];
  toolsAvailable: boolean;
  permissionSnapshot: SkillPermissionSnapshot | null;
}

const getProjectRootsFromAppState = (): SkillProjectRoot[] => {
  const appState = useAppStore.getState();
  const projects = [
    ...(appState.standaloneProjects ?? []),
    ...appState.projectGroups.flatMap((group) => group.projects),
  ];
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

const createTurnId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `skill-turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const buildSkillPermissionSnapshot = (
  conversationId: string,
  skills: SkillManifest[],
  getSettings: (skillId: string) => SkillSettings,
  turnId: string = createTurnId(),
): SkillPermissionSnapshot => ({
  conversationId,
  turnId,
  capturedAt: new Date().toISOString(),
  skills: Object.fromEntries(
    skills.map((skill) => {
      const settings = getSettings(skill.id);
      const trustCurrent = isSkillTrustCurrent(settings, skill.contentHash);
      return [
        skill.id,
        {
          skillId: skill.id,
          enabled: settings.enabled,
          scriptsEnabled: settings.scriptsEnabled && trustCurrent,
          hasScripts: skill.scripts.length > 0,
          contentHash: skill.contentHash,
          trustedContentHash: settings.trust?.contentHash,
        },
      ];
    }),
  ),
});

const canRunSkillScriptFromSnapshot = (
  snapshot: SkillPermissionSnapshot | null | undefined,
  skillId: string,
): boolean => {
  if (!snapshot) return true;
  const permission = snapshot.skills[skillId];
  return permission?.enabled === true &&
    permission.scriptsEnabled === true &&
    permission.hasScripts === true &&
    Boolean(permission.contentHash) &&
    permission.contentHash === permission.trustedContentHash;
};

let settingsMutationVersion = 0;

interface SkillsStore {
  skills: SkillManifest[];
  settingsBySkillId: Record<string, SkillSettings>;
  activationsByConversationId: Record<string, SkillActivation[] | undefined>;
  permissionSnapshotsByConversationId: Record<string, SkillPermissionSnapshot | undefined>;
  isLoading: boolean;
  saving: boolean;
  lastError: string | null;
  loadSettings: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  installSkillFromLocalPath: (sourcePath: string) => Promise<void>;
  createSkillTemplate: (
    data: Omit<SkillTemplateCreateRequest, 'projectRoots'>,
  ) => Promise<SkillManifest | null>;
  openSkillLocation: (
    skillId: string,
    target: SkillLocationOpenRequest['target'],
  ) => Promise<boolean>;
  setSkillEnabled: (skillId: string, enabled: boolean) => Promise<void>;
  setSkillScriptsEnabled: (skillId: string, scriptsEnabled: boolean) => Promise<void>;
  getSkillSettings: (skillId: string) => SkillSettings;
  getSkillById: (skillId: string) => SkillManifest | null;
  getEnabledSkills: () => SkillManifest[];
  getEnabledLoadableSkills: (options?: {
    includeShadowed?: boolean;
    permissionSnapshot?: SkillPermissionSnapshot | null;
  }) => SkillManifest[];
  getRunnableSkillIds: (options?: {
    includeShadowed?: boolean;
    permissionSnapshot?: SkillPermissionSnapshot | null;
  }) => string[];
  findEnabledSkillByName: (name: string) => SkillManifest | null;
  resolveEnabledSkillMentions: (content: string) => SkillManifest[];
  createSkillPermissionSnapshot: (conversationId: string, turnId?: string) => SkillPermissionSnapshot;
  getSkillPermissionSnapshot: (conversationId: string) => SkillPermissionSnapshot | null;
  clearSkillPermissionSnapshot: (conversationId: string) => void;
  prepareSkillsForTurn: (params: {
    conversationId: string;
    content: string;
    contextRefs?: Array<ContextReference | PersistedContextReference>;
    toolsAvailable: boolean;
    permissionSnapshot?: SkillPermissionSnapshot | null;
  }) => Promise<SkillTurnPreparation>;
  activateSkill: (skillId: string, conversationId?: string) => Promise<string>;
  readSkillResource: (skillId: string, resourcePath: string) => Promise<string>;
  runSkillScript: (
    request: SkillScriptRunRequest,
    permissionSnapshot?: SkillPermissionSnapshot | null,
  ) => Promise<string>;
}

export const useSkillsStore = create<SkillsStore>((set, get) => ({
  skills: [],
  settingsBySkillId: {},
  activationsByConversationId: {},
  permissionSnapshotsByConversationId: {},
  isLoading: false,
  saving: false,
  lastError: null,

  loadSettings: async () => {
    const hydrationVersion = settingsMutationVersion;
    set({ isLoading: true, lastError: null });
    try {
      const settingsBySkillId = readStoredSkillSettings();
      const response = await services.listSkills({ projectRoots: getProjectRootsFromAppState() });
      const currentSettings =
        hydrationVersion === settingsMutationVersion
          ? settingsBySkillId
          : get().settingsBySkillId;
      const migratedSettings = migrateLegacySkillSettings(currentSettings, response.skills);
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
    settingsMutationVersion += 1;
    set({ saving: true, lastError: null });
    try {
      const installed = await services.installSkillFromLocalPath({ sourcePath });
      const nextSettings = {
        ...get().settingsBySkillId,
        [installed.id]: { enabled: true, scriptsEnabled: false },
      };
      await writeStoredSkillSettings(nextSettings);
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

  createSkillTemplate: async (data) => {
    settingsMutationVersion += 1;
    set({ saving: true, lastError: null });
    try {
      const created = await services.createSkillTemplate({
        ...data,
        projectRoots: getProjectRootsFromAppState(),
      });
      const createdSettings = {
        ...get().settingsBySkillId,
        [created.skill.id]: { enabled: true, scriptsEnabled: false },
      };
      await writeStoredSkillSettings(createdSettings);
      set({
        skills: Array.from(
          new Map([...get().skills, created.skill].map((skill) => [skill.id, skill])).values(),
        ),
        settingsBySkillId: createdSettings,
      });
      const response = await services.listSkills({ projectRoots: getProjectRootsFromAppState() });
      const nextSettings = {
        ...migrateLegacySkillSettings(createdSettings, response.skills),
        [created.skill.id]: { enabled: true, scriptsEnabled: false },
      };
      await writeStoredSkillSettings(nextSettings);
      set({
        skills: response.skills,
        settingsBySkillId: nextSettings,
        saving: false,
      });
      return created.skill;
    } catch (error) {
      set({ saving: false, lastError: toServiceError(error).message });
      return null;
    }
  },

  openSkillLocation: async (skillId, target) => {
    set({ lastError: null });
    try {
      await services.openSkillLocation({
        skillId,
        target,
        projectRoots: getProjectRootsFromAppState(),
      });
      return true;
    } catch (error) {
      set({ lastError: toServiceError(error).message });
      return false;
    }
  },

  setSkillEnabled: async (skillId, enabled) => {
    settingsMutationVersion += 1;
    const state = get();
    const current = state.settingsBySkillId[skillId] ?? DEFAULT_SKILL_SETTINGS;
    const settingsBySkillId = {
      ...state.settingsBySkillId,
      [skillId]: normalizeSkillSettings({
        ...current,
        enabled,
      }),
    };
    set({ settingsBySkillId, lastError: null });
    try {
      await writeStoredSkillSettings(settingsBySkillId);
    } catch (error) {
      set({ lastError: toServiceError(error).message });
    }
  },

  setSkillScriptsEnabled: async (skillId, scriptsEnabled) => {
    settingsMutationVersion += 1;
    const state = get();
    const current = state.settingsBySkillId[skillId] ?? DEFAULT_SKILL_SETTINGS;
    const skill = state.skills.find((candidate) => candidate.id === skillId);
    if (scriptsEnabled && !skill?.contentHash) {
      set({ lastError: 'Cannot trust this skill because its content hash is unavailable.' });
      return;
    }
    const settingsBySkillId = {
      ...state.settingsBySkillId,
      [skillId]: normalizeSkillSettings({
        ...current,
        scriptsEnabled,
        ...(scriptsEnabled
          ? {
              trust: {
                contentHash: skill!.contentHash,
                grantedAt: new Date().toISOString(),
                grantedBy: 'user',
              },
            }
          : {}),
      }),
    };
    set({ settingsBySkillId, lastError: null });
    try {
      await writeStoredSkillSettings(settingsBySkillId);
    } catch (error) {
      set({ lastError: toServiceError(error).message });
    }
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

  createSkillPermissionSnapshot: (conversationId, turnId) => {
    const snapshot = buildSkillPermissionSnapshot(
      conversationId,
      get().skills,
      get().getSkillSettings,
      turnId,
    );
    set((state) => ({
      permissionSnapshotsByConversationId: {
        ...state.permissionSnapshotsByConversationId,
        [conversationId]: snapshot,
      },
    }));
    return snapshot;
  },

  getSkillPermissionSnapshot: (conversationId) =>
    get().permissionSnapshotsByConversationId[conversationId] ?? null,

  clearSkillPermissionSnapshot: (conversationId) => {
    set((state) => {
      const next = { ...state.permissionSnapshotsByConversationId };
      delete next[conversationId];
      return { permissionSnapshotsByConversationId: next };
    });
  },

  prepareSkillsForTurn: async ({
    conversationId,
    content,
    contextRefs = [],
    toolsAvailable,
    permissionSnapshot = null,
  }) => {
    const state = get();
    const availabilityOptions = { includeShadowed: true, permissionSnapshot };
    const enabledSkills = state.getEnabledLoadableSkills(availabilityOptions);
    const effectiveEnabledSkills = state.getEnabledLoadableSkills({ permissionSnapshot });
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
        warnings.push(`Skill ${ref.title} changed location. Re-select it from the slash menu.`);
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
          `Skill "${mention}" is ambiguous. Select the exact skill from the slash menu.`,
        );
      }
    }

    if (!toolsAvailable && selectedSkills.some((skill) =>
      skill.resources.length > 0 || skill.scripts.length > 0
    )) {
      warnings.push(
        'Skill instructions were loaded, but resources and scripts require a model/provider with native tool calling.',
      );
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
      permissionSnapshot,
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

  runSkillScript: async (request, permissionSnapshot = null) => {
    if (!canRunSkillScriptFromSnapshot(permissionSnapshot, request.skillId)) {
      return 'Skill scripts were not enabled when this turn started. Enable Scripts for this skill in Settings and retry on the next turn.';
    }
    const settings = get().getSkillSettings(request.skillId);
    if (!settings.enabled) {
      return 'This skill is disabled. Enable this skill in Settings before running scripts.';
    }
    if (!settings.scriptsEnabled) {
      return 'Scripts are disabled for this skill. Enable Scripts for this skill in Settings.';
    }
    const skill = get().getSkillById(request.skillId);
    if (!skill || !isSkillTrustCurrent(settings, skill.contentHash)) {
      return 'This skill changed or has not been trusted. Approve its current content before running scripts.';
    }
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
