import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const configurationGetSnapshot = mock(async (_projectIds: string[]) => ({
  schemaVersion: 1,
  marker: 'snapshot',
}));
const configurationGetDocument = mock(async () => ({
  marker: 'document',
}));
const configurationValidateDocument = mock(async () => ({
  marker: 'validation',
}));
const configurationApplyPatch = mock(async () => ({
  marker: 'patch',
}));

mock.module('./configurationClient', () => ({
  configurationApplyPatch,
  configurationGetDocument,
  configurationGetSnapshot,
  configurationValidateDocument,
}));

const { handleConfigToolCall } = await import('./configToolIntegration');

const expectNoClientCall = () => {
  expect(configurationGetSnapshot).not.toHaveBeenCalled();
  expect(configurationGetDocument).not.toHaveBeenCalled();
  expect(configurationValidateDocument).not.toHaveBeenCalled();
  expect(configurationApplyPatch).not.toHaveBeenCalled();
};

describe('configToolIntegration', () => {
  beforeEach(() => {
    configurationGetSnapshot.mockClear();
    configurationGetDocument.mockClear();
    configurationValidateDocument.mockClear();
    configurationApplyPatch.mockClear();
  });

  afterAll(() => mock.restore());

  it.each([
    [{}, 'Unknown configuration document: (missing).'],
    [{ document: 'unknown' }, 'Unknown configuration document: unknown.'],
  ])('rejects an absent or unknown document kind', async (args, message) => {
    await expect(handleConfigToolCall('config_get', args)).rejects.toThrow(message);
    expectNoClientCall();
  });

  it.each([undefined, '   '])(
    'requires a project id for project-scoped operations',
    async (projectId) => {
      await expect(handleConfigToolCall('config_get', {
        document: 'settings',
        scope: 'project',
        ...(projectId === undefined ? {} : { project_id: projectId }),
      })).rejects.toThrow('project_id is required for project configuration.');
      expectNoClientCall();
    },
  );

  it('uses the user scope by default', async () => {
    const result = await handleConfigToolCall('config_get', { document: ' settings ' });

    expect(configurationGetDocument).toHaveBeenCalledWith('settings', { type: 'user' });
    expect(result).toBe(JSON.stringify({ marker: 'document' }, null, 2));
  });

  it('requires a value for validation, while accepting an explicit undefined value', async () => {
    await expect(handleConfigToolCall('config_validate', {
      document: 'tools',
    })).rejects.toThrow('value is required for config_validate.');
    expect(configurationValidateDocument).not.toHaveBeenCalled();

    const result = await handleConfigToolCall('config_validate', {
      document: 'tools',
      value: undefined,
    });

    expect(configurationValidateDocument).toHaveBeenCalledWith({
      kind: 'tools',
      scope: { type: 'user' },
      document: undefined,
    });
    expect(result).toBe(JSON.stringify({ marker: 'validation' }, null, 2));
  });

  it('requires a non-blank expected etag for patches', async () => {
    await expect(handleConfigToolCall('config_patch', {
      document: 'agents',
      patch: [{ op: 'remove', path: '/models/chat' }],
    })).rejects.toThrow('expected_etag is required for config_patch.');
    expect(configurationApplyPatch).not.toHaveBeenCalled();
  });

  it.each([
    [[], 'patch must contain at least one RFC 6902 operation.'],
    [[null], 'patch[0] must be an object.'],
    [[['replace']], 'patch[0] must be an object.'],
    [[{ op: 42, path: '/models/chat' }], 'patch[0] requires string op and path fields.'],
    [[{ op: 'replace', path: null }], 'patch[0] requires string op and path fields.'],
  ])('rejects a malformed patch before writing configuration', async (patch, message) => {
    await expect(handleConfigToolCall('config_patch', {
      document: 'agents',
      expected_etag: 'etag-1',
      patch,
    })).rejects.toThrow(message);
    expect(configurationApplyPatch).not.toHaveBeenCalled();
  });

  it('preserves from and value while forcing the agent source', async () => {
    const result = await handleConfigToolCall('config_patch', {
      document: 'providers',
      scope: 'project',
      project_id: ' project-a ',
      expected_etag: ' etag-1 ',
      patch: [
        { op: 'move', from: '/providers/old', path: '/providers/new', ignored: true },
        { op: 'replace', path: '/providers/new/enabled', value: false },
        { op: 'add', path: '/providers/new/token', value: null },
      ],
    });

    expect(configurationApplyPatch).toHaveBeenCalledWith({
      kind: 'providers',
      scope: { type: 'project', projectId: 'project-a' },
      expectedEtag: 'etag-1',
      patch: [
        { op: 'move', from: '/providers/old', path: '/providers/new' },
        { op: 'replace', path: '/providers/new/enabled', value: false },
        { op: 'add', path: '/providers/new/token', value: null },
      ],
      source: 'agent',
    });
    expect(result).toBe(JSON.stringify({ marker: 'patch' }, null, 2));
  });

  it('filters non-string project ids for config_list without rewriting strings', async () => {
    const result = await handleConfigToolCall('config_list', {
      project_ids: ['project-a', 12, null, ' project-b ', false],
    });

    expect(configurationGetSnapshot).toHaveBeenCalledWith(['project-a', ' project-b ']);
    expect(result).toBe(JSON.stringify({ schemaVersion: 1, marker: 'snapshot' }, null, 2));
  });

  it('uses an empty project list when config_list receives no project_ids array', async () => {
    await handleConfigToolCall('config_list', {});

    expect(configurationGetSnapshot).toHaveBeenCalledWith([]);
  });

  it('returns undefined for an unrelated tool without touching configuration', async () => {
    await expect(handleConfigToolCall('terminal_run', {})).resolves.toBeUndefined();
    expectNoClientCall();
  });
});
