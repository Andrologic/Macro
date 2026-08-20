import { describe, expect, it } from 'bun:test';
import { listConfigPath, parseConfigVirtualPath } from './configVirtualScope';

describe('configVirtualScope', () => {
  it('maps user and project virtual documents without revealing physical paths', () => {
    expect(parseConfigVirtualPath('@config/user/settings.json')).toEqual({
      kind: 'settings',
      scope: { type: 'user' },
      path: '@config/user/settings.json',
    });
    expect(parseConfigVirtualPath('@config/projects/project-1/tools.json')).toEqual({
      kind: 'tools',
      scope: { type: 'project', projectId: 'project-1' },
      path: '@config/projects/project-1/tools.json',
    });
  });

  it('rejects documents that are unavailable in project scope', () => {
    expect(() => parseConfigVirtualPath('@config/projects/project-1/providers.json'))
      .toThrow('cannot use project scope');
  });

  it('rejects project identifiers that cannot be used as safe directory names', () => {
    for (const projectId of ['..', 'project name', 'project.name', 'CON', 'LPT1']) {
      expect(() => parseConfigVirtualPath(`@config/projects/${projectId}/tools.json`))
        .toThrow('Invalid project id');
    }
  });

  it('ignores ordinary workspace paths', () => {
    expect(parseConfigVirtualPath('src/config/settings.json')).toBeNull();
  });

  it('lists known projects from the project registry without requiring a config snapshot', async () => {
    let registryLoads = 0;
    const result = await listConfigPath('@config/projects', async () => {
      registryLoads += 1;
      return {
        validProjectIds: ['project-b', 'project-a'],
      } as Awaited<ReturnType<typeof import('./validProjectRegistry').loadValidProjectRegistrySnapshot>>;
    });

    expect(registryLoads).toBe(1);
    expect(result).toBe('@config/projects/project-a/\n@config/projects/project-b/');
  });
});
