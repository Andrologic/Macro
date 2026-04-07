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

let repository: Repository;
let diffSession: {
  repositoryId: string;
  changeId: string;
  rightDraftContent: string;
  lastLoadedModifiedContent: string;
  isDirty: boolean;
  isSaving: boolean;
  isHydratingFullContext: boolean;
} | null;
let importCounter = 0;

const markAsReviewedMock = mock(() => undefined);
const loadChangeContextMock = mock(async () => undefined);
const updateRightDraftMock = mock(() => undefined);
const resetRightDraftMock = mock(() => undefined);
const saveRightDraftMock = mock(async () => undefined);
const goToAdjacentDiffMock = mock(() => undefined);
const openDiffModalMock = mock(() => undefined);

const createStoreHook = <T,>(getSnapshot: () => T) => {
  const hook = () => getSnapshot();
  return hook;
};

const loadModal = async () => {
  mock.restore();

  const useFileChangesStore = createStoreHook(() => ({
    getRepository: (repositoryId: string) => (repositoryId === repository.id ? repository : undefined),
    getChange: (_repositoryId: string, changeId: string) => repository.changes.find((change) => change.id === changeId),
    getDiffModalSession: () => diffSession,
    markAsReviewed: markAsReviewedMock,
    loadChangeContext: loadChangeContextMock,
    updateRightDraft: updateRightDraftMock,
    resetRightDraft: resetRightDraftMock,
    saveRightDraft: saveRightDraftMock,
    goToAdjacentDiff: goToAdjacentDiffMock,
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

  mock.module('../ui/CodeViewer', () => ({
    CodeViewer: ({
      code,
      readOnly,
      onChange,
      onEditorReady,
    }: {
      code: string;
      readOnly?: boolean;
      onChange?: (value: string) => void;
      onEditorReady?: (view: unknown) => void;
    }) => {
      onEditorReady?.(null);
      return (
        <textarea
          data-code-viewer={readOnly ? 'readonly' : 'editable'}
          readOnly={readOnly}
          value={code}
          onChange={(event) => onChange?.(event.target.value)}
        />
      );
    },
  }));

  mock.module('../ui/ConfirmPromptModal', () => ({
    ConfirmPromptModal: ({
      isOpen,
      title,
    }: {
      isOpen: boolean;
      title: string;
    }) => (isOpen ? <div data-confirm-modal="true">{title}</div> : null),
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
    markAsReviewedMock.mockClear();
    loadChangeContextMock.mockClear();
    updateRightDraftMock.mockClear();
    resetRightDraftMock.mockClear();
    saveRightDraftMock.mockClear();
    goToAdjacentDiffMock.mockClear();
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

  it('renders the redesigned modal with key metadata and stage areas', async () => {
    const { FileChangesDiffModal } = await loadModal();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await Promise.resolve();
    });

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('src/feature.tsx');
    expect(document.body.textContent).toContain('File 2/3');
    expect(document.body.textContent).toContain('+7');
    expect(document.body.textContent).toContain('-2');
    expect(document.body.textContent).toContain('Before');
    expect(document.body.textContent).toContain('After');
  });

  it('navigates to previous and next files from the header controls', async () => {
    const { FileChangesDiffModal } = await loadModal();

    await act(async () => {
      root?.render(<FileChangesDiffModal onClose={() => undefined} />);
      await Promise.resolve();
    });

    findButton('Previous')?.click();
    findButton('Next')?.click();

    expect(goToAdjacentDiffMock).toHaveBeenCalledTimes(2);
    expect(goToAdjacentDiffMock).toHaveBeenNthCalledWith(1, 'previous');
    expect(goToAdjacentDiffMock).toHaveBeenNthCalledWith(2, 'next');
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

  it('disables validation while dirty and keeps save/reset available', async () => {
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

    expect(findButton('Validate')?.disabled).toBe(true);
    expect(findButton('Save right side')?.disabled).toBe(false);
    expect(findButton('Reset draft')?.disabled).toBe(false);
  });

  it('shows deleted files as read-only in the review flow', async () => {
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

    expect(document.body.textContent).toContain('Deleted files are read-only in this validation flow.');
    expect(findButton('Save right side')?.disabled).toBe(true);
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
    expect(document.body.textContent).toContain('Preparing editor...');
    expect(document.body.textContent).toContain('No textual diff is available for this file. The split view falls back to full-file content.');
  });
});
