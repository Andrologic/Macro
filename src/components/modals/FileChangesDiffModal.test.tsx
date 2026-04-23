import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  type FileChangeEntry,
  type FileDiffModalSession,
  type ReviewRepositoryState,
} from '../../stores/useFileChangesStore';
import type { FileChangesDiffModal as FileChangesDiffModalComponent } from './FileChangesDiffModal';
import type { useAppStore as UseAppStoreHook } from '../../stores/useAppStore';
import type { useFileChangesStore as UseFileChangesStoreHook } from '../../stores/useFileChangesStore';
import type { ParsedDiffHunk } from '../../services/gitDiffParser';

let FileChangesDiffModal!: typeof FileChangesDiffModalComponent;
let useAppStore!: typeof UseAppStoreHook;
let useFileChangesStore!: typeof UseFileChangesStoreHook;
let initialStoreState: ReturnType<typeof useFileChangesStore.getState> | null = null;
let initialAppStoreState: ReturnType<typeof useAppStore.getState> | null = null;
let importCounter = 0;

const loadFileChangesDiffModalModules = async () => {
  importCounter += 1;

  const preferencesModule = await import(
    `../../services/preferences.ts?file-changes-diff-modal-preferences-test=${importCounter}`
  );
  mock.module('../../services/preferences', () => ({
    ...preferencesModule,
  }));

  const appStoreModule = await import(
    `../../stores/useAppStore.ts?file-changes-diff-modal-app-store-test=${importCounter}`
  );
  mock.module('../../stores/useAppStore', () => ({
    ...appStoreModule,
  }));

  const fileChangesStoreModule = await import(
    `../../stores/useFileChangesStore.ts?file-changes-diff-modal-store-test=${importCounter}`
  );
  mock.module('../../stores/useFileChangesStore', () => ({
    ...fileChangesStoreModule,
  }));

  ({ FileChangesDiffModal } = await import(
    `./FileChangesDiffModal.tsx?file-changes-diff-modal-test=${importCounter}`
  ));
  ({ useAppStore } = appStoreModule);
  ({ useFileChangesStore } = fileChangesStoreModule);
  initialStoreState = useFileChangesStore.getState();
  initialAppStoreState = useAppStore.getState();
};

const makeHunk = (header: string): ParsedDiffHunk => ({
  header,
  oldStart: 1,
  oldCount: 1,
  newStart: 1,
  newCount: 1,
  lines: [],
});

const buildRepository = (): ReviewRepositoryState => {
  const changes: FileChangeEntry[] = [
    {
      id: 'change-1',
      path: 'src/list.ts',
      status: 'added',
      additions: 4,
      deletions: 0,
      originalContent: '',
      indexContent: '',
      modifiedContent: 'const list = [];',
      language: 'typescript',
      hunks: [makeHunk('@@ -0,0 +1 @@')],
      contextMode: 'focused',
      canEdit: true,
      hasValidatedStage: false,
      validatedRemovedLineNumbers: [],
      validatedAddedLineNumbers: [],
    },
    {
      id: 'change-2',
      path: 'src/feature.tsx',
      status: 'modified',
      additions: 7,
      deletions: 2,
      originalContent: 'before();',
      indexContent: 'validated();',
      modifiedContent: 'after();',
      language: 'typescript',
      hunks: [makeHunk('@@ -1 +1 @@')],
      contextMode: 'focused',
      canEdit: true,
      hasValidatedStage: true,
      validatedRemovedLineNumbers: [1],
      validatedAddedLineNumbers: [1],
    },
    {
      id: 'change-3',
      path: 'src/legacy.ts',
      status: 'deleted',
      additions: 0,
      deletions: 9,
      originalContent: 'legacy();',
      indexContent: 'legacy();',
      modifiedContent: '',
      language: 'typescript',
      hunks: [makeHunk('@@ -1 +0 @@')],
      contextMode: 'full',
      canEdit: false,
      hasValidatedStage: false,
      validatedRemovedLineNumbers: [],
      validatedAddedLineNumbers: [],
    },
  ];

  return {
    id: 'repo-1',
    projectId: 'project-1',
    repoPath: '/tmp/repo-1',
    worktreePath: '/tmp/worktree-1',
    branchName: 'feature/review-redesign',
    planBranchName: null,
    changes,
    stagedPaths: ['src/feature.tsx'],
    selectedChangeId: 'change-2',
    stats: {
      pendingVisibleFileCount: 3,
      validatedStagedFileCount: 1,
      additions: 11,
      deletions: 11,
    },
    commitMessageDraft: 'feat: review redesign',
    commitState: 'idle',
    loadingChangeId: null,
    savingChangeId: null,
    lastError: null,
    lastCommitHash: null,
  };
};

const buildSession = (overrides: Partial<FileDiffModalSession> = {}): FileDiffModalSession => ({
  repositoryId: 'repo-1',
  changeId: 'change-2',
  originalContent: 'before();',
  rightDraftContent: 'after();',
  lastLoadedModifiedContent: 'after();',
  isDirty: false,
  isSaving: false,
  isHydratingFullContext: false,
  ...overrides,
});

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(label)
  ) as HTMLButtonElement | undefined;

const dispatchEscape = async () => {
  const event = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { value: 'Escape' });
  document.dispatchEvent(event);
  await flushRender();
};

describe('FileChangesDiffModal', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let repository: ReviewRepositoryState;
  let diffSession: FileDiffModalSession;
  let stageChangesMock: ReturnType<typeof mock>;
  let revertChangesMock: ReturnType<typeof mock>;
  let updateRightDraftMock: ReturnType<typeof mock>;
  let resetRightDraftMock: ReturnType<typeof mock>;
  let saveRightDraftMock: ReturnType<typeof mock>;
  let openDiffModalMock: ReturnType<typeof mock>;

  const seedStore = () => {
    useFileChangesStore.setState({
      ...useFileChangesStore.getState(),
      repositories: [repository],
      selectedRepositoryId: repository.id,
      selectedDiffTarget: { repositoryId: repository.id, changeId: diffSession.changeId },
      diffModalSession: diffSession,
      isDiffModalOpen: true,
      isLoading: false,
      isCommitting: false,
      lastError: null,
      stageChanges: stageChangesMock,
      revertChanges: revertChangesMock,
      updateRightDraft: updateRightDraftMock,
      resetRightDraft: resetRightDraftMock,
      saveRightDraft: saveRightDraftMock,
      openDiffModal: openDiffModalMock,
    });
  };

  beforeEach(async () => {
    mock.restore();
    await loadFileChangesDiffModalModules();
    localStorage.clear();
    useAppStore.setState({ codeOverflowMode: 'wrap' });
    repository = buildRepository();
    diffSession = buildSession();
    stageChangesMock = mock(async () => undefined);
    revertChangesMock = mock(async () => undefined);
    updateRightDraftMock = mock(() => undefined);
    resetRightDraftMock = mock(() => undefined);
    saveRightDraftMock = mock(async () => undefined);
    openDiffModalMock = mock(() => undefined);

    seedStore();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    container?.remove();
    localStorage.clear();
    root = null;
    container = null;
    if (initialStoreState) {
      useFileChangesStore.setState(initialStoreState, true);
    }
    if (initialAppStoreState) {
      useAppStore.setState(initialAppStoreState, true);
    }
    mock.restore();
  });

  it('renders the current repository, file metadata, and live diff view from the store session', async () => {
    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('src/feature.tsx');
    expect(document.body.querySelector('.macro-diff-merge-root')).not.toBeNull();
    expect(document.body.querySelector('[data-language="typescript"]')).not.toBeNull();
  });

  it('opens another file from the compact file rail', async () => {
    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    const targetButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('list.ts')
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      targetButton?.click();
      await flushRender();
    });

    expect(openDiffModalMock).toHaveBeenCalledTimes(1);
    expect(openDiffModalMock).toHaveBeenCalledWith('repo-1', 'change-1');
  });

  it('asks for confirmation before closing with Escape when the draft is dirty', async () => {
    diffSession = buildSession({
      isDirty: true,
      rightDraftContent: 'after();\n// local edit',
    });
    seedStore();

    const onClose = mock(() => undefined);

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={onClose} />);
      await flushRender();
    });

    await act(async () => {
      await dispatchEscape();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Discard unsaved changes?');
  });

  it('closes immediately with Escape when there are no unsaved changes', async () => {
    const onClose = mock(() => undefined);

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={onClose} />);
      await flushRender();
    });

    await act(async () => {
      await dispatchEscape();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows save and reset controls while the draft is dirty', async () => {
    localStorage.setItem('macro_implementDiffPresentationMode', JSON.stringify('full'));
    diffSession = buildSession({
      isDirty: true,
      rightDraftContent: 'after();\n// edited',
    });
    seedStore();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Unsaved draft. Save to validate or reset.');
    expect(findButton('Save draft')?.disabled).toBe(false);
    expect(findButton('Reset draft')?.disabled).toBe(false);
    expect(findButton('Validate file')).toBeUndefined();
  });

  it('shows validate and revert controls for a clean pending file', async () => {
    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    expect(findButton('Validate file')).toBeDefined();
    expect(findButton('Revert')).toBeDefined();
    expect(findButton('Reset draft')).toBeUndefined();
    expect(findButton('Focused diff')).toBeDefined();
    expect(findButton('Full file context')).toBeDefined();
  });

  it('switches between focused diff and full file context on demand', async () => {
    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    expect(document.body.querySelector('.cm-merge-b .cm-content[contenteditable="false"]')).not.toBeNull();
    expect(document.body.querySelector('.cm-merge-revert button')).not.toBeNull();

    await act(async () => {
      findButton('Full file context')?.click();
      await flushRender();
    });

    expect(document.body.querySelector('.cm-merge-b .cm-content[contenteditable="true"]')).not.toBeNull();
    expect(document.body.querySelector('.cm-merge-revert button')).not.toBeNull();
  });

  it('renders added files in a right-only editable layout without context toggles or chunk reverts', async () => {
    repository.selectedChangeId = 'change-1';
    diffSession = buildSession({
      changeId: 'change-1',
      originalContent: '',
      rightDraftContent: 'const list = [];',
      lastLoadedModifiedContent: 'const list = [];',
    });
    seedStore();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    const host = document.body.querySelector('[data-layout="right-only"]') as HTMLElement | null;
    const leftEditor = document.body.querySelector('.cm-mergeViewEditor:first-child') as HTMLElement | null;
    const rightEditor = document.body.querySelector('.cm-mergeViewEditor:last-child') as HTMLElement | null;

    expect(host).not.toBeNull();
    expect(findButton('Focused diff')).toBeUndefined();
    expect(findButton('Full file context')).toBeUndefined();
    expect(document.body.querySelector('.cm-merge-revert button')).toBeNull();
    expect(document.body.textContent).not.toContain('No textual diff is available for this file.');
    expect(document.body.querySelector('.cm-merge-b .cm-content[contenteditable="true"]')).not.toBeNull();
    expect(leftEditor).not.toBeNull();
    expect(rightEditor).not.toBeNull();
    expect(getComputedStyle(leftEditor as HTMLElement).display).toBe('none');
    expect(getComputedStyle(rightEditor as HTMLElement).display).toBe('flex');
  });

  it('shows the staged legend when a file has already validated lines', async () => {
    repository.changes[1] = {
      ...repository.changes[1],
      hasValidatedStage: true,
    };
    diffSession = buildSession();
    seedStore();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Validated lines are shown with a softer highlight until commit.');
    expect(findButton('Validate file')).toBeDefined();
    expect(findButton('Revert')).toBeDefined();
  });

  it('validates the current file from the footer by staging it', async () => {
    seedStore();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    await act(async () => {
      findButton('Validate file')?.click();
      await flushRender();
    });

    expect(stageChangesMock).toHaveBeenCalledTimes(1);
    expect(stageChangesMock).toHaveBeenCalledWith('repo-1', ['change-2']);
  });

  it('reverts the current pending file from the footer', async () => {
    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    await act(async () => {
      findButton('Revert')?.click();
      await flushRender();
    });

    expect(revertChangesMock).toHaveBeenCalledTimes(1);
    expect(revertChangesMock).toHaveBeenCalledWith('repo-1', ['change-2']);
  });

  it('renders non-editable deleted files as read-only while keeping footer actions available', async () => {
    repository.selectedChangeId = 'change-3';
    diffSession = buildSession({
      changeId: 'change-3',
      originalContent: 'legacy();',
      rightDraftContent: '',
      lastLoadedModifiedContent: '',
    });
    seedStore();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    expect(findButton('Reset draft')).toBeUndefined();
    expect(findButton('Validate file')).toBeDefined();
    expect(findButton('Revert')).toBeDefined();
    expect(document.body.querySelector('.cm-merge-revert button')).toBeNull();
    expect(document.body.querySelector('.cm-merge-b .cm-content[contenteditable="false"]')).not.toBeNull();
  });

  it('renders deleted files in a left-only read-only layout without context toggles or chunk reverts', async () => {
    repository.selectedChangeId = 'change-3';
    diffSession = buildSession({
      changeId: 'change-3',
      originalContent: 'legacy();',
      rightDraftContent: '',
      lastLoadedModifiedContent: '',
    });
    seedStore();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    const host = document.body.querySelector('[data-layout="left-only"]') as HTMLElement | null;
    const leftEditor = document.body.querySelector('.cm-mergeViewEditor:first-child') as HTMLElement | null;
    const rightEditor = document.body.querySelector('.cm-mergeViewEditor:last-child') as HTMLElement | null;

    expect(host).not.toBeNull();
    expect(findButton('Focused diff')).toBeUndefined();
    expect(findButton('Full file context')).toBeUndefined();
    expect(document.body.querySelector('.cm-merge-revert button')).toBeNull();
    expect(document.body.textContent).not.toContain('No textual diff is available for this file.');
    expect(document.body.querySelector('.cm-merge-a .cm-content')).not.toBeNull();
    expect(leftEditor).not.toBeNull();
    expect(rightEditor).not.toBeNull();
    expect(getComputedStyle(leftEditor as HTMLElement).display).toBe('flex');
    expect(getComputedStyle(rightEditor as HTMLElement).display).toBe('none');
  });

  it('surfaces loading, missing diff text, and repository errors without breaking layout', async () => {
    repository.lastError = 'Repository is temporarily unavailable.';
    repository.changes[1] = {
      ...repository.changes[1],
      hunks: [],
    };
    diffSession = buildSession({
      isHydratingFullContext: true,
    });
    seedStore();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    expect(document.body.textContent).toContain('Repository is temporarily unavailable.');
    expect(document.body.textContent).toContain('Loading file diff...');
    expect(document.body.textContent).toContain('Working...');
    expect(document.body.querySelector('.macro-diff-merge-root')).toBeNull();
  });

  it('keeps the same diff view instance when full context hydrates for the same file', async () => {
    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    const initialTitle = document.body.querySelector('h2');
    expect(initialTitle?.textContent).toContain('src/feature.tsx');

    await act(async () => {
      repository.selectedChangeId = 'change-1';
      diffSession = buildSession({
        changeId: 'change-1',
        originalContent: '',
        rightDraftContent: 'const list = [];',
        lastLoadedModifiedContent: 'const list = [];',
      });
      useFileChangesStore.setState({
        repositories: [repository],
        selectedDiffTarget: { repositoryId: repository.id, changeId: 'change-1' },
        diffModalSession: diffSession,
      });
      await flushRender();
    });

    const mergeRootBeforeHydration = document.body.querySelector('.macro-diff-merge-root');
    expect(document.body.querySelector('h2')?.textContent).toContain('src/list.ts');

    repository.changes[0] = {
      ...repository.changes[0],
      originalContent: '// before\nconst list = [];',
      modifiedContent: '// before\nconst list = [];\nconsole.log(list);',
    };

    await act(async () => {
      diffSession = buildSession({
        changeId: 'change-1',
        originalContent: '// before\nconst list = [];',
        rightDraftContent: '// before\nconst list = [];\nconsole.log(list);',
        lastLoadedModifiedContent: '// before\nconst list = [];\nconsole.log(list);',
      });
      useFileChangesStore.setState({
        repositories: [repository],
        selectedDiffTarget: { repositoryId: repository.id, changeId: 'change-1' },
        diffModalSession: diffSession,
      });
      await flushRender();
    });

    expect(mergeRootBeforeHydration).not.toBeNull();
    expect(document.body.querySelector('.macro-diff-merge-root')).not.toBeNull();
    expect(document.body.querySelector('h2')?.textContent).toContain('src/list.ts');
    expect(document.body.textContent).toContain('console.log(list);');
  });

  it('inherits the global code overflow preference for the embedded diff viewer', async () => {
    useAppStore.setState({ codeOverflowMode: 'horizontal_scroll' });

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    expect(document.body.querySelector('[data-overflow-mode="horizontal_scroll"]')).not.toBeNull();
  });
});
