import React from 'react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type FileChange = {
  id: string;
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  reviewed: boolean;
  originalContent: string;
  modifiedContent: string;
  language: string;
  hunks: Array<{ header: string; lines: unknown[] }>;
  contextMode: 'default' | 'expanded' | 'full';
  canEdit: boolean;
};

type Repository = {
  id: string;
  branchName: string;
  changes: FileChange[];
  loadingChangeId: string | null;
  savingChangeId: string | null;
  lastError: string | null;
  stats: {
    total: number;
    reviewed: number;
  };
};

type DiffSession = {
  repositoryId: string;
  changeId: string;
  rightDraftContent: string;
  lastLoadedModifiedContent: string;
  isDirty: boolean;
  isSaving: boolean;
  isHydratingFullContext: boolean;
};

let repository: Repository;
let diffSession: DiffSession | null;
let importCounter = 0;
let latestDiffProps: { original: string; modified: string; language: string | undefined } | null = null;
let diffRenderCount = 0;

const markAsReviewedMock = mock(() => undefined);
const updateRightDraftMock = mock(() => undefined);
const resetRightDraftMock = mock(() => undefined);
const saveRightDraftMock = mock(async () => undefined);
const openDiffModalMock = mock(() => undefined);

const createStoreHook = <T,>(getSnapshot: () => T) => {
  const hook = <S,>(selector?: (state: T) => S): T | S => {
    const snapshot = getSnapshot();
    return selector ? selector(snapshot) : snapshot;
  };
  return hook;
};

const loadModal = async () => {
  mock.restore();

  const useFileChangesStore = createStoreHook(() => ({
    repositories: [repository],
    diffModalSession: diffSession,
    markAsReviewed: markAsReviewedMock,
    updateRightDraft: updateRightDraftMock,
    resetRightDraft: resetRightDraftMock,
    saveRightDraft: saveRightDraftMock,
    openDiffModal: openDiffModalMock,
  }));

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (
        key: string,
        fallbackOrOptions?: string | { defaultValue?: string },
        maybeOptions?: { defaultValue?: string }
      ) => {
        if (typeof fallbackOrOptions === 'string') {
          return fallbackOrOptions;
        }
        return maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? key;
      },
    }),
  }));

  mock.module('../../stores/useFileChangesStore', () => ({
    useFileChangesStore,
  }));

  mock.module('../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../ui/Button', () => ({
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
  }));

  mock.module('../ui/DiffMergeView', () => ({
    DiffMergeView: ({
      original,
      modified,
      language,
      onEditorReady,
    }: {
      original: string;
      modified: string;
      language?: string;
      onEditorReady?: (editor: unknown) => void;
    }) => {
      latestDiffProps = { original, modified, language };
      diffRenderCount += 1;

      React.useEffect(() => {
        onEditorReady?.({
          a: { state: { doc: { toString: () => original } } },
          b: { state: { doc: { toString: () => modified } } },
          dom: document.createElement('div'),
        });

        return () => {
          onEditorReady?.(null);
        };
      }, [modified, onEditorReady, original]);

      return (
        <div
          data-diff-merge-view="true"
          data-original={original}
          data-modified={modified}
          data-language={language ?? ''}
          data-render-count={diffRenderCount}
        />
      );
    },
  }));

  mock.module('../ui/ConfirmPromptModal', () => ({
    ConfirmPromptModal: ({ title }: { title: string }) => <div data-confirm-modal="true">{title}</div>,
  }));

  importCounter += 1;
  return import(`./FileChangesDiffModal.tsx?test=${importCounter}`);
};

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(label)
  ) as HTMLButtonElement | undefined;

const dispatchEscape = async () => {
  const event = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { value: 'Escape' });
  document.dispatchEvent(event);
  await Promise.resolve();
};

describe('FileChangesDiffModal', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    latestDiffProps = null;
    diffRenderCount = 0;
    markAsReviewedMock.mockClear();
    updateRightDraftMock.mockClear();
    resetRightDraftMock.mockClear();
    saveRightDraftMock.mockClear();
    openDiffModalMock.mockClear();

    repository = {
      id: 'repo-1',
      branchName: 'feature/review-redesign',
      loadingChangeId: null,
      savingChangeId: null,
      lastError: null,
      stats: {
        total: 3,
        reviewed: 1,
      },
      changes: [
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
          hunks: [{ header: '@@ -0,0 +1 @@', lines: [] }],
          contextMode: 'default',
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
          hunks: [{ header: '@@ -1 +1 @@', lines: [] }],
          contextMode: 'expanded',
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
          hunks: [{ header: '@@ -1 +0 @@', lines: [] }],
          contextMode: 'full',
          canEdit: false,
        },
      ],
    };

    diffSession = {
      repositoryId: repository.id,
      changeId: 'change-2',
      rightDraftContent: 'after();',
      lastLoadedModifiedContent: 'after();',
      isDirty: false,
      isSaving: false,
      isHydratingFullContext: false,
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    root = null;
    container = null;
    diffSession = null;
    mock.restore();
  });

  it('renders the current repository, file metadata, and diff props from the store session', async () => {
    const { FileChangesDiffModal } = await loadModal();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await Promise.resolve();
    });

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('feature/review-redesign');
    expect(document.body.textContent).toContain('1 / 3 files validated');
    expect(document.body.textContent).toContain('src/feature.tsx');
    expect(document.body.querySelector('[data-diff-merge-view="true"]')).not.toBeNull();
    expect(latestDiffProps).toEqual({
      original: 'before();',
      modified: 'after();',
      language: 'typescript',
    });
  });

  it('opens another file from the compact file rail', async () => {
    const { FileChangesDiffModal } = await loadModal();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await Promise.resolve();
    });

    const targetButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('list.ts')
    ) as HTMLButtonElement | undefined;

    targetButton?.click();

    expect(openDiffModalMock).toHaveBeenCalledTimes(1);
    expect(openDiffModalMock).toHaveBeenCalledWith('repo-1', 'change-1');
  });

  it('asks for confirmation before closing with Escape when the draft is dirty', async () => {
    diffSession = {
      ...diffSession!,
      isDirty: true,
      rightDraftContent: 'after();\n// local edit',
    };

    const onClose = mock(() => undefined);
    const { FileChangesDiffModal } = await loadModal();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={onClose} />);
      await Promise.resolve();
    });

    await act(async () => {
      await dispatchEscape();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-confirm-modal="true"]')?.textContent).toContain('Discard unsaved changes?');
  });

  it('closes immediately with Escape when there are no unsaved changes', async () => {
    const onClose = mock(() => undefined);
    const { FileChangesDiffModal } = await loadModal();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={onClose} />);
      await Promise.resolve();
    });

    await act(async () => {
      await dispatchEscape();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows save and reset controls while the draft is dirty', async () => {
    diffSession = {
      ...diffSession!,
      isDirty: true,
      rightDraftContent: 'after();\n// edited',
    };

    const { FileChangesDiffModal } = await loadModal();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Unsaved draft. Save to validate or reset.');
    expect(findButton('Save draft')?.disabled).toBe(false);
    expect(findButton('Reset draft')?.disabled).toBe(false);
    expect(findButton('Validate file')).toBeUndefined();
  });

  it('renders deleted files with the current session content and disabled actions', async () => {
    diffSession = {
      ...diffSession!,
      changeId: 'change-3',
      rightDraftContent: '',
      lastLoadedModifiedContent: '',
    };

    const { FileChangesDiffModal } = await loadModal();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await Promise.resolve();
    });

    expect(latestDiffProps).toEqual({
      original: 'legacy();',
      modified: '',
      language: 'typescript',
    });
    expect(findButton('Reset draft')?.disabled).toBe(true);
    expect(findButton('Validate file')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Validated');
  });

  it('surfaces loading, missing diff text, and repository errors without breaking layout', async () => {
    repository.lastError = 'Repository is temporarily unavailable.';
    repository.changes[1] = {
      ...repository.changes[1],
      hunks: [],
    };
    diffSession = {
      ...diffSession!,
      isHydratingFullContext: true,
    };

    const { FileChangesDiffModal } = await loadModal();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Repository is temporarily unavailable.');
    expect(document.body.textContent).toContain('Loading full file context...');
    expect(document.body.textContent).toContain('Working...');
    expect(document.body.querySelector('[data-diff-merge-view="true"]')).toBeNull();
  });

  it('updates diff props when switching files and when the loaded context changes', async () => {
    const { FileChangesDiffModal } = await loadModal();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await Promise.resolve();
    });

    expect(latestDiffProps).toEqual({
      original: 'before();',
      modified: 'after();',
      language: 'typescript',
    });

    diffSession = {
      ...diffSession!,
      changeId: 'change-1',
      rightDraftContent: 'const list = [];',
      lastLoadedModifiedContent: 'const list = [];',
    };

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await Promise.resolve();
    });

    expect(latestDiffProps).toEqual({
      original: '',
      modified: 'const list = [];',
      language: 'typescript',
    });

    repository.changes[0] = {
      ...repository.changes[0],
      contextMode: 'full',
      originalContent: '// before\nconst list = [];',
      modifiedContent: '// before\nconst list = [];\nconsole.log(list);',
    };
    diffSession = {
      ...diffSession!,
      changeId: 'change-1',
      rightDraftContent: '// before\nconst list = [];\nconsole.log(list);',
      lastLoadedModifiedContent: '// before\nconst list = [];\nconsole.log(list);',
    };

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await Promise.resolve();
    });

    expect(latestDiffProps).toEqual({
      original: '// before\nconst list = [];',
      modified: '// before\nconst list = [];\nconsole.log(list);',
      language: 'typescript',
    });
    expect(diffRenderCount).toBeGreaterThanOrEqual(3);
  });
});
