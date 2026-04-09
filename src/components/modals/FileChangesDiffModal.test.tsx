import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileChangesDiffModal } from './FileChangesDiffModal';
import { useAppStore } from '../../stores/useAppStore';
import {
  useFileChangesStore,
  type FileChangeEntry,
  type FileDiffModalSession,
  type ReviewRepositoryState,
} from '../../stores/useFileChangesStore';
import type { ParsedDiffHunk } from '../../services/gitDiffParser';

const initialStoreState = useFileChangesStore.getState();
const initialAppStoreState = useAppStore.getState();

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
      reviewed: false,
      originalContent: '',
      modifiedContent: 'const list = [];',
      language: 'typescript',
      hunks: [makeHunk('@@ -0,0 +1 @@')],
      contextMode: 'focused',
      canEdit: true,
    },
    {
      id: 'change-2',
      path: 'src/feature.tsx',
      status: 'modified',
      additions: 7,
      deletions: 2,
      reviewed: false,
      originalContent: 'before();',
      modifiedContent: 'after();',
      language: 'typescript',
      hunks: [makeHunk('@@ -1 +1 @@')],
      contextMode: 'focused',
      canEdit: true,
    },
    {
      id: 'change-3',
      path: 'src/legacy.ts',
      status: 'deleted',
      additions: 0,
      deletions: 9,
      reviewed: true,
      originalContent: 'legacy();',
      modifiedContent: '',
      language: 'typescript',
      hunks: [makeHunk('@@ -1 +0 @@')],
      contextMode: 'full',
      canEdit: false,
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
    selectedChangeId: 'change-2',
    stats: {
      total: 3,
      reviewed: 1,
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
  let markAsReviewedMock: ReturnType<typeof mock>;
  let markAsUnreviewedMock: ReturnType<typeof mock>;
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
      markAsReviewed: markAsReviewedMock,
      markAsUnreviewed: markAsUnreviewedMock,
      revertChanges: revertChangesMock,
      updateRightDraft: updateRightDraftMock,
      resetRightDraft: resetRightDraftMock,
      saveRightDraft: saveRightDraftMock,
      openDiffModal: openDiffModalMock,
    });
  };

  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ codeOverflowMode: 'wrap' });
    repository = buildRepository();
    diffSession = buildSession();
    markAsReviewedMock = mock(async () => undefined);
    markAsUnreviewedMock = mock(() => undefined);
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
    useFileChangesStore.setState(initialStoreState, true);
    useAppStore.setState(initialAppStoreState, true);
  });

  it('renders the current repository, file metadata, and live diff view from the store session', async () => {
    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('feature/review-redesign');
    expect(document.body.textContent).toContain('1 / 3 files validated');
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
    expect(findButton('Invalidate')).toBeUndefined();
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

  it('shows only invalidate for a validated file', async () => {
    repository.changes[1] = {
      ...repository.changes[1],
      reviewed: true,
    };
    repository.stats.reviewed = 2;
    diffSession = buildSession();
    seedStore();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    expect(findButton('Invalidate')).toBeDefined();
    expect(findButton('Validate file')).toBeUndefined();
    expect(findButton('Revert')).toBeUndefined();
  });

  it('invalidates the current file from the footer', async () => {
    repository.changes[1] = {
      ...repository.changes[1],
      reviewed: true,
    };
    repository.stats.reviewed = 2;
    seedStore();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await flushRender();
    });

    await act(async () => {
      findButton('Invalidate')?.click();
      await flushRender();
    });

    expect(markAsUnreviewedMock).toHaveBeenCalledTimes(1);
    expect(markAsUnreviewedMock).toHaveBeenCalledWith('repo-1', 'change-2');
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

  it('renders non-editable files as truly read-only with no revert controls', async () => {
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
    expect(findButton('Invalidate')).toBeDefined();
    expect(findButton('Validate file')).toBeUndefined();
    expect(findButton('Revert')).toBeUndefined();
    expect(document.body.textContent).toContain('Validated');
    expect(document.body.querySelector('.cm-merge-revert button')).toBeNull();
    expect(document.body.querySelector('.cm-merge-b .cm-content[contenteditable="false"]')).not.toBeNull();
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
