import { describe, expect, it } from 'bun:test';
import {
  getTaskProjectCommand,
  loadTaskProjectCommandRegistry,
  mergeTaskProjectCommandRegistry,
  normalizeTaskProjectCommandPath,
  resolveTaskProjectCommandRegistry,
} from './taskProjectCommands';
import type { ConfigSnapshot } from '../types/generated/config';

const configSnapshot = (): ConfigSnapshot => ({
  schemaVersion: 1,
  effective: {
    tools: {
      projectCommands: {
        'C:/dev/api': {
          projectId: 'api',
          projectName: 'API global stale',
          projectPath: 'C:/dev/api',
          command: 'global command',
          openTerminalOnRun: true,
          updatedAt: '2026-03-24T00:00:00.000Z',
        },
      },
    },
  },
  projectEffective: {
    api: {
      tools: {
        projectCommands: {
          'C:/dev/api': {
            projectId: 'api',
            projectName: 'API',
            projectPath: 'C:/dev/api',
            command: 'bun test:api',
            openTerminalOnRun: true,
            updatedAt: '2026-03-24T00:00:00.000Z',
          },
          'C:/dev/web': {
            projectId: 'web',
            projectName: 'Web',
            projectPath: 'C:/dev/web',
            command: 'bun test:web',
            openTerminalOnRun: true,
            updatedAt: '2026-03-24T00:00:00.000Z',
          },
        },
      },
    },
  },
  documents: [],
  provenance: [],
  diagnostics: [],
  pendingRestartPaths: [],
});

describe('taskProjectCommands', () => {
  it('normalizes project paths with forward slashes and no trailing slash', () => {
    expect(normalizeTaskProjectCommandPath('C:\\dev\\api\\')).toBe('C:/dev/api');
  });

  it('merges commands by normalized project path', () => {
    const registry = mergeTaskProjectCommandRegistry(
      {
        version: 2,
        commandsByProjectPath: {},
      },
      [
        {
          projectId: 'api',
          projectName: 'API',
          projectPath: 'C:\\dev\\api\\',
          command: 'bun test',
          worktreeSetupCommand: '',
          openTerminalOnRun: true,
        },
      ]
    );

    expect(getTaskProjectCommand(registry, 'C:/dev/api')?.command).toBe('bun test');
    expect(getTaskProjectCommand(registry, 'C:\\dev\\api\\')?.projectName).toBe('API');
    expect(getTaskProjectCommand(registry, 'C:/dev/api')?.openTerminalOnRun).toBe(true);
  });

  it('removes a command entry when the draft is saved empty', () => {
    const registry = mergeTaskProjectCommandRegistry(
      {
        version: 2,
        commandsByProjectPath: {
          'C:/dev/api': {
            projectId: 'api',
            projectName: 'API',
            projectPath: 'C:/dev/api',
            command: 'bun test',
            worktreeSetupCommand: '',
            openTerminalOnRun: true,
            updatedAt: '2026-03-24T00:00:00.000Z',
          },
        },
      },
      [
        {
          projectId: 'api',
          projectName: 'API',
          projectPath: 'C:/dev/api',
          command: '   ',
          worktreeSetupCommand: '   ',
          openTerminalOnRun: true,
        },
      ]
    );

    expect(getTaskProjectCommand(registry, 'C:/dev/api')).toBeNull();
  });

  it('keeps an entry when only the worktree setup command is configured', () => {
    const registry = mergeTaskProjectCommandRegistry(
      {
        version: 2,
        commandsByProjectPath: {},
      },
      [
        {
          projectId: 'api',
          projectName: 'API',
          projectPath: 'C:/dev/api',
          command: '   ',
          worktreeSetupCommand: 'bun install',
          openTerminalOnRun: true,
        },
      ]
    );

    const entry = getTaskProjectCommand(registry, 'C:/dev/api');
    expect(entry?.command).toBe('');
    expect(entry?.worktreeSetupCommand).toBe('bun install');
    expect(registry.version).toBe(3);
  });

  it('resolves commands from the requested project effective snapshot only', () => {
    const registry = resolveTaskProjectCommandRegistry(configSnapshot(), ['api']);

    expect(getTaskProjectCommand(registry, 'C:/dev/api')?.command).toBe('bun test:api');
    expect(getTaskProjectCommand(registry, 'C:/dev/web')).toBeNull();
  });

  it('requests an explicit normalized project scope from the snapshot loader', async () => {
    const requestedScopes: string[][] = [];
    const registry = await loadTaskProjectCommandRegistry(
      [' api ', 'api'],
      async (projectIds) => {
        requestedScopes.push(projectIds);
        return configSnapshot();
      },
    );

    expect(requestedScopes).toEqual([['api']]);
    expect(getTaskProjectCommand(registry, 'C:/dev/api')?.command).toBe('bun test:api');
  });
});
