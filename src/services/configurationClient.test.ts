import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { ConfigSnapshot } from '../types/generated/config';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import {
  applyScopedToolRestrictions,
  configurationApplyPatch,
  loadScopedTurnConfiguration,
  resolveScopedModelSelection,
  resolveScopedTurnConfiguration,
} from './configurationClient';

const snapshot = (effective: ConfigSnapshot['effective']): ConfigSnapshot => ({
  schemaVersion: 1,
  effective,
  projectEffective: {},
  documents: [],
  provenance: [],
  diagnostics: [],
  pendingRestartPaths: [],
});

describe('scoped turn configuration', () => {
  afterEach(() => removeTauriRuntimeMock());

  it('removes a tool disabled by the effective project configuration', () => {
    const config = resolveScopedTurnConfiguration(
      snapshot({
        tools: {
          riskLevel: 'strict',
          builtIn: { terminal_run: false },
          modes: { Implement: { git_commit: false } },
        },
        agents: { maxTurns: 8 },
      }),
      {
        projectIds: ['project-web'],
        focusProjectId: 'project-web',
        mode: 'Implement',
      },
    );

    expect(
      applyScopedToolRestrictions(
        ['read', 'terminal_run', 'git_commit'],
        config,
      ),
    ).toEqual(['read']);
    expect(config.riskLevel).toBe('strict');
    expect(config.maxTurns).toBe(8);
  });

  it('keeps simultaneous project scopes independent', async () => {
    const resolveForProject = async (
      projectId: string,
      disabledToolId: string,
    ) => {
      await Promise.resolve();
      const config = resolveScopedTurnConfiguration(
        snapshot({
          tools: {
            riskLevel: projectId === 'project-a' ? 'strict' : 'balanced',
            builtIn: { [disabledToolId]: false },
            modes: {},
          },
          agents: {},
        }),
        { projectIds: [projectId], focusProjectId: projectId, mode: 'Implement' },
      );
      return {
        config,
        tools: applyScopedToolRestrictions(['read', 'write'], config),
      };
    };

    const [projectA, projectB] = await Promise.all([
      resolveForProject('project-a', 'write'),
      resolveForProject('project-b', 'read'),
    ]);

    expect(projectA.config.projectIds).toEqual(['project-a']);
    expect(projectA.config.focusProjectId).toBe('project-a');
    expect(projectA.config.riskLevel).toBe('strict');
    expect(projectA.tools).toEqual(['read']);
    expect(projectB.config.projectIds).toEqual(['project-b']);
    expect(projectB.config.focusProjectId).toBe('project-b');
    expect(projectB.config.riskLevel).toBe('balanced');
    expect(projectB.tools).toEqual(['write']);
  });

  it('loads each concurrent turn with its own explicit project scope', async () => {
    const requestedScopes: string[][] = [];
    const load = async (projectIds: string[]) => {
      requestedScopes.push(projectIds);
      await Promise.resolve();
      const projectId = projectIds[0];
      return snapshot({
        tools: {
          riskLevel: projectId === 'project-a' ? 'strict' : 'balanced',
          builtIn: { [projectId === 'project-a' ? 'write' : 'read']: false },
          modes: {},
        },
        agents: {},
      });
    };

    const [projectA, projectB] = await Promise.all([
      loadScopedTurnConfiguration(
        { projectIds: ['project-a'], focusProjectId: 'project-a', mode: 'Implement' },
        load,
      ),
      loadScopedTurnConfiguration(
        { projectIds: ['project-b'], focusProjectId: 'project-b', mode: 'Implement' },
        load,
      ),
    ]);

    expect(requestedScopes).toEqual([['project-a'], ['project-b']]);
    expect(applyScopedToolRestrictions(['read', 'write'], projectA)).toEqual(['read']);
    expect(applyScopedToolRestrictions(['read', 'write'], projectB)).toEqual(['write']);
  });

  it('uses a focused project model only when the focus is unambiguous', () => {
    const input = snapshot({
      agents: {
        models: {
          chat: { providerId: 'global-provider', modelId: 'global-model' },
        },
      },
      tools: { modes: {} },
    });
    input.projectEffective = {
      'project-a': {
        agents: {
          models: {
            chat: {
              providerId: 'project-provider',
              modelId: 'project-model',
              reasoningEffort: 'high',
            },
          },
        },
      },
      'project-b': { agents: { models: {} } },
    };

    const focused = resolveScopedTurnConfiguration(input, {
      projectIds: ['project-a', 'project-b'],
      focusProjectId: 'project-a',
      mode: 'Chat',
    });
    expect(resolveScopedModelSelection(focused, ['chat'])).toEqual({
      providerId: 'project-provider',
      modelId: 'project-model',
      reasoningEffort: 'high',
    });

    const ambiguous = resolveScopedTurnConfiguration(input, {
      projectIds: ['project-a', 'project-b'],
      focusProjectId: null,
      mode: 'Chat',
    });
    expect(resolveScopedModelSelection(ambiguous, ['chat'])).toEqual({
      providerId: 'global-provider',
      modelId: 'global-model',
      reasoningEffort: null,
    });
  });

  it('routes agent and interface patches through distinct trusted IPC commands', async () => {
    const invoke = installTauriRuntimeMock(mock(async () => ({
      status: 'applied',
      document: {
        kind: 'settings',
        scope: { type: 'user' },
        value: {},
        etag: 'sha256:next',
        readOnly: false,
        invalid: false,
        filePath: 'settings.json',
        diagnostics: [],
      },
      pendingChange: null,
      restartRequired: false,
    })));
    const base = {
      kind: 'settings' as const,
      scope: { type: 'user' as const },
      expectedEtag: 'sha256:current',
      patch: [{ op: 'add', path: '/language', value: 'fr' }],
    };

    await configurationApplyPatch({ ...base, source: 'agent' });
    await configurationApplyPatch({ ...base, source: 'userInterface' });

    const commands = (invoke as unknown as {
      mock: { calls: Array<[string, unknown?]> };
    }).mock.calls.map(([command]) => command);
    expect(commands).toEqual([
      'config_patch',
      'config_apply_patch',
    ]);
  });
});
