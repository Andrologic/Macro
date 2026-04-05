import { beforeEach, describe, expect, it, mock } from 'bun:test';

const loadPreferenceMock = mock(async (_key: string): Promise<string | null> => null);
const savePreferenceMock = mock(async () => undefined);
const openExternalTargetMock = mock(async () => undefined);
const listExternalAppsMock = mock(async () => ({
  editor: [
    { id: 'none', label: 'Do nothing', action: 'editor', kind: 'none' },
    { id: 'vscode', label: 'Visual Studio Code', action: 'editor', kind: 'detected' },
    { id: 'cursor', label: 'Cursor', action: 'editor', kind: 'detected' },
  ],
  terminal: [
    { id: 'none', label: 'Do nothing', action: 'terminal', kind: 'none' },
    { id: 'terminal', label: 'Terminal', action: 'terminal', kind: 'builtin' },
    { id: 'wezterm', label: 'WezTerm', action: 'terminal', kind: 'detected' },
  ],
  files: [
    { id: 'none', label: 'Do nothing', action: 'files', kind: 'none' },
    { id: 'finder', label: 'Finder', action: 'files', kind: 'builtin' },
  ],
}));

mock.module('./preferences', () => ({
  PREF_KEYS: {
    PROJECT_OPEN_EDITOR_APP: 'projectOpenEditorApp',
    PROJECT_OPEN_TERMINAL_APP: 'projectOpenTerminalApp',
    PROJECT_OPEN_FILES_APP: 'projectOpenFilesApp',
    PROJECT_OPEN_EDITOR_COMMAND: 'projectOpenEditorCommand',
    PROJECT_OPEN_TERMINAL_COMMAND: 'projectOpenTerminalCommand',
    PROJECT_OPEN_FILES_COMMAND: 'projectOpenFilesCommand',
  },
  loadPreference: loadPreferenceMock,
  savePreference: savePreferenceMock,
}));

mock.module('./tauriIpc', () => ({
  isTauriAvailable: () => true,
  listExternalApps: listExternalAppsMock,
  openExternalTarget: openExternalTargetMock,
}));

describe('projectOpeners', () => {
  beforeEach(() => {
    loadPreferenceMock.mockReset();
    savePreferenceMock.mockReset();
    openExternalTargetMock.mockReset();
    listExternalAppsMock.mockReset();
    listExternalAppsMock.mockImplementation(async () => ({
      editor: [
        { id: 'none', label: 'Do nothing', action: 'editor', kind: 'none' },
        { id: 'vscode', label: 'Visual Studio Code', action: 'editor', kind: 'detected' },
        { id: 'cursor', label: 'Cursor', action: 'editor', kind: 'detected' },
      ],
      terminal: [
        { id: 'none', label: 'Do nothing', action: 'terminal', kind: 'none' },
        { id: 'terminal', label: 'Terminal', action: 'terminal', kind: 'builtin' },
        { id: 'wezterm', label: 'WezTerm', action: 'terminal', kind: 'detected' },
      ],
      files: [
        { id: 'none', label: 'Do nothing', action: 'files', kind: 'none' },
        { id: 'finder', label: 'Finder', action: 'files', kind: 'builtin' },
      ],
    }));
  });

  it('migrates a legacy command preference to a detected app id', async () => {
    loadPreferenceMock.mockImplementation(async (key: string) => {
      if (key === 'projectOpenEditorCommand') {
        return 'code -n';
      }
      return null;
    });

    const { loadProjectOpenSettings } = await import('./projectOpeners');
    const result = await loadProjectOpenSettings();

    expect(result.selectedAppIdsByAction.editor).toBe('vscode');
    expect(savePreferenceMock).toHaveBeenCalledWith('projectOpenEditorApp', 'vscode');
  });

  it('uses none when saved and hides the action', async () => {
    loadPreferenceMock.mockImplementation(async (key: string) => {
      if (key === 'projectOpenTerminalApp') {
        return 'none';
      }
      return null;
    });

    const { loadProjectOpenSettings, shouldRenderProjectOpenAction } = await import('./projectOpeners');
    const result = await loadProjectOpenSettings();

    expect(result.selectedAppIdsByAction.terminal).toBe('none');
    expect(shouldRenderProjectOpenAction(result.selectedAppIdsByAction, 'terminal')).toBe(false);
  });

  it('opens with the selected app id', async () => {
    const { openProjectInExternalApp } = await import('./projectOpeners');

    await openProjectInExternalApp({
      targetPath: '/workspace/api',
      action: 'editor',
      appId: 'cursor',
    });

    expect(openExternalTargetMock).toHaveBeenCalledWith({
      targetPath: '/workspace/api',
      action: 'editor',
      appId: 'cursor',
    });
  });
});
