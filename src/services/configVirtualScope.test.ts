import { describe, expect, it } from 'bun:test';
import { parseConfigVirtualPath } from './configVirtualScope';

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

  it('ignores ordinary workspace paths', () => {
    expect(parseConfigVirtualPath('src/config/settings.json')).toBeNull();
  });
});
