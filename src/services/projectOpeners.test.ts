import { beforeEach, describe, expect, it, mock } from 'bun:test';

const loadPreferenceMock = mock(async () => 'code -n');
const openExternalTargetMock = mock(async () => undefined);

mock.module('./preferences', () => ({
  PREF_KEYS: {
    PROJECT_OPEN_EDITOR_COMMAND: 'projectOpenEditorCommand',
    PROJECT_OPEN_TERMINAL_COMMAND: 'projectOpenTerminalCommand',
    PROJECT_OPEN_FILES_COMMAND: 'projectOpenFilesCommand',
  },
  loadPreference: loadPreferenceMock,
}));

mock.module('./tauriIpc', () => ({
  openExternalTarget: openExternalTargetMock,
}));

describe('openProjectInExternalApp', () => {
  beforeEach(() => {
    loadPreferenceMock.mockReset();
    openExternalTargetMock.mockReset();
  });

  it('passes the stored command override to tauri', async () => {
    loadPreferenceMock.mockImplementation(async () => 'code -n');
    const { openProjectInExternalApp } = await import('./projectOpeners');

    await openProjectInExternalApp({
      targetPath: '/workspace/api',
      action: 'editor',
    });

    expect(openExternalTargetMock).toHaveBeenCalledWith({
      targetPath: '/workspace/api',
      action: 'editor',
      commandOverride: 'code -n',
    });
  });

  it('falls back to defaults when the stored command is empty', async () => {
    loadPreferenceMock.mockImplementation(async () => '   ');
    const { openProjectInExternalApp } = await import('./projectOpeners');

    await openProjectInExternalApp({
      targetPath: '/workspace/api',
      action: 'files',
    });

    const firstCall = ((openExternalTargetMock.mock.calls as unknown) as Array<[{
      targetPath: string;
      action: string;
      commandOverride?: string;
    }]>)[0]?.[0] as
      | { targetPath: string; action: string; commandOverride?: string }
      | undefined;

    expect(openExternalTargetMock).toHaveBeenCalledTimes(1);
    expect(firstCall).toMatchObject({
      targetPath: '/workspace/api',
      action: 'files',
    });
    expect(typeof firstCall?.commandOverride).toBe('string');
  });
});
