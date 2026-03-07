import { beforeEach, describe, expect, it, mock } from 'bun:test';

const repoPath = 'C:/repos/macro';

const initialOriginalFiles: Record<string, string> = {
  'src/main.ts': 'const value = 1;\nconsole.log(value);',
  'README.md': 'Hello',
};

let currentFiles: Record<string, string> = {};

const gitStatusMock = mock(async () => ({
  staged_files: [],
  unstaged_files: [
    { path: 'src/main.ts', status: 'modified' },
    { path: 'README.md', status: 'modified' },
  ],
  untracked_files: [],
}));

const buildPatch = (path: string): string => {
  const original = initialOriginalFiles[path] ?? '';
  const modified = currentFiles[path] ?? '';
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');

  const patchLines = [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${originalLines.length} +1,${modifiedLines.length} @@`,
  ];

  const maxLines = Math.max(originalLines.length, modifiedLines.length);
  for (let index = 0; index < maxLines; index += 1) {
    const originalLine = originalLines[index];
    const modifiedLine = modifiedLines[index];

    if (originalLine === modifiedLine) {
      patchLines.push(` ${originalLine ?? ''}`);
      continue;
    }

    if (originalLine !== undefined) {
      patchLines.push(`-${originalLine}`);
    }

    if (modifiedLine !== undefined) {
      patchLines.push(`+${modifiedLine}`);
    }
  }

  return patchLines.join('\n');
};

const gitDiffMock = mock(async ({ paths }: { paths?: string[] }) => buildPatch(paths?.[0] || ''));

const fsWriteFileMock = mock(async ({ path, content }: { path: string; content: string }) => {
  const normalized = path.replace(/\\/g, '/');
  const relative = normalized.startsWith(`${repoPath}/`)
    ? normalized.slice(repoPath.length + 1)
    : normalized;
  currentFiles[relative] = content;
  return {
    path: normalized,
    bytes_written: content.length,
    created: false,
  };
});

mock.module('../services/tauriIpc', () => ({
  isTauriAvailable: () => true,
  gitStatus: gitStatusMock,
  gitDiff: gitDiffMock,
  fsWriteFile: fsWriteFileMock,
}));

const taskStoreState = {
  activeRepositoryPath: repoPath,
  getTaskById: () => undefined,
  completeTask: async () => undefined,
};

mock.module('./useTaskStore', () => ({
  useTaskStore: {
    getState: () => taskStoreState,
  },
}));

const appStoreState = {
  selectedProjectId: null,
  selectedGroupId: null,
  selectedTaskId: null,
  projectGroups: [],
  getProjectById: () => null,
};

mock.module('./useAppStore', () => ({
  useAppStore: {
    getState: () => appStoreState,
  },
}));

const { resolveChangeFilePath, useFileChangesStore } = await import('./useFileChangesStore');

describe('useFileChangesStore', () => {
  beforeEach(() => {
    currentFiles = {
      'src/main.ts': 'const value = 2;\nconsole.log(value);',
      'README.md': 'Hello\nupdated',
    };

    gitStatusMock.mockClear();
    gitDiffMock.mockClear();
    fsWriteFileMock.mockClear();

    useFileChangesStore.setState({
      changes: [],
      selectedChangeId: null,
      isDiffModalOpen: false,
      isLoading: false,
      isCommitting: false,
      loadingChangeId: null,
      savingChangeId: null,
      lastError: null,
      lastCommitHash: null,
    });
  });

  it('builds absolute file paths with normalized separators', () => {
    expect(resolveChangeFilePath('C:\\repos\\macro\\', 'src\\main.ts')).toBe('C:/repos/macro/src/main.ts');
  });

  it('saves manual edits, resets review for the edited file, and keeps other files reviewed', async () => {
    const store = useFileChangesStore.getState();

    await store.loadCurrentChanges();
    store.markAsReviewed('change-README.md');

    await store.startEditingChange('change-src/main.ts');
    expect(useFileChangesStore.getState().getChange('change-src/main.ts')?.contextMode).toBe('full');

    store.updateEditingBuffer('change-src/main.ts', 'const value = 3;\nconsole.log(value);');
    await store.saveEditedChange('change-src/main.ts');

    expect(fsWriteFileMock).toHaveBeenCalledWith({
      path: 'C:/repos/macro/src/main.ts',
      content: 'const value = 3;\nconsole.log(value);',
      createDirs: true,
      allowOutsideWorkspace: true,
    });

    const refreshedMain = useFileChangesStore.getState().getChange('change-src/main.ts');
    const refreshedReadme = useFileChangesStore.getState().getChange('change-README.md');

    expect(refreshedMain?.reviewed).toBe(false);
    expect(refreshedMain?.isEditing).toBe(false);
    expect(refreshedMain?.modifiedContent).toContain('const value = 3;');
    expect(refreshedReadme?.reviewed).toBe(true);
  });
});
