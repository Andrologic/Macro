import { describe, expect, it } from 'bun:test';
import {
  getTaskProjectCommand,
  mergeTaskProjectCommandRegistry,
  normalizeTaskProjectCommandPath,
} from './taskProjectCommands';

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
          openTerminalOnRun: true,
        },
      ]
    );

    expect(getTaskProjectCommand(registry, 'C:/dev/api')).toBeNull();
  });
});
