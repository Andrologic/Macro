import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAppStore } from '../../stores/useAppStore';
import type { Project, ProjectGitFlowDetection, ProjectGroup } from '../../types';

let importCounter = 0;
let previewProjectGitSetupMock = mock(async (_data: { path: string }) => buildDetection());
let createProjectMock = mock(async (_payload: unknown) => undefined);
let createProjectWithGitSetupMock = mock(async (_payload: unknown) => undefined);
let closeProjectModalMock = mock(() => undefined);

const loadProjectModal = async () => {
  mock.restore();
  importCounter += 1;

  mock.module('react-i18next', () => ({
    initReactI18next: {
      type: '3rdParty',
      init: () => undefined,
    },
    useTranslation: () => ({
      t: (_key: string, fallbackOrOptions?: string | Record<string, unknown>, options?: Record<string, unknown>) => {
        const fallback = typeof fallbackOrOptions === 'string' ? fallbackOrOptions : _key;
        const interpolation = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : options;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_match, key) =>
          String(interpolation?.[key] ?? '')
        );
      },
      i18n: {
        language: 'en-US',
        changeLanguage: mock(async () => undefined),
      },
    }),
  }));
  mock.module('@tauri-apps/plugin-dialog', () => ({
    open: mock(async () => null),
  }));
  mock.module('../../services', () => ({
    services: {
      previewProjectGitSetup: (data: { path: string }) => previewProjectGitSetupMock(data),
    },
  }));

  return import(`./ProjectModal.tsx?project-modal-test=${importCounter}`);
};

const buildProject = (overrides: Partial<Project>): Project => ({
  id: 'project-id',
  name: 'Existing Project',
  mountName: 'existing-project',
  path: 'C:/work/existing',
  created_at: '2026-04-13T12:00:00.000Z',
  status: 'active',
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
  ...overrides,
});

const buildProjectGroup = (overrides: Partial<ProjectGroup> = {}): ProjectGroup => ({
  id: 'group-id',
  name: 'Suite',
  isOpen: true,
  projects: [],
  ...overrides,
});

const buildDetection = (
  overrides: Partial<ProjectGitFlowDetection> = {}
): ProjectGitFlowDetection => ({
  repoDetected: false,
  branches: [],
  currentBranch: null,
  suggestedMainBranch: null,
  suggestedBaseBranch: null,
  suggestedCommitBranch: null,
  requiresConfirmation: false,
  setupState: 'ready',
  hasInitialCommit: true,
  resolvedRepoRootPath: null,
  repoResolution: 'none',
  initialCommitPreviewPaths: [],
  initialCommitPreviewCount: 0,
  initialCommitRiskFlags: [],
  recommendedActionSequence: [],
  ...overrides,
});

const findButton = (text: string): HTMLButtonElement => {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === text
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
};

const changeInput = async (placeholder: string, value: string) => {
  const input = Array.from(document.body.querySelectorAll('input')).find(
    (candidate) => candidate.getAttribute('placeholder') === placeholder
  ) as HTMLInputElement | undefined;
  expect(input).toBeDefined();
  const reactPropsKey = Object.keys(input!).find((key) => key.startsWith('__reactProps$'));
  expect(reactPropsKey).toBeDefined();
  const reactProps = (input! as unknown as Record<string, { onChange?: (event: unknown) => void }>)[
    reactPropsKey!
  ];
  expect(reactProps.onChange).toBeDefined();

  await act(async () => {
    reactProps.onChange?.({ target: { value } });
    await Promise.resolve();
  });
};

describe('ProjectModal', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    previewProjectGitSetupMock = mock(async (_data: { path: string }) => buildDetection());
    createProjectMock = mock(async (_payload: unknown) => undefined);
    createProjectWithGitSetupMock = mock(async (_payload: unknown) => undefined);
    closeProjectModalMock = mock(() => undefined);

    useAppStore.setState({
      projectModalOpen: true,
      projectModalGroupId: null,
      projectGroups: [],
      createProject: createProjectMock as never,
      createProjectWithGitSetup: createProjectWithGitSetupMock as never,
      closeProjectModal: closeProjectModalMock,
    });

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
    container = null;
    root = null;
    mock.restore();
  });

  const renderModal = async () => {
    const { default: ProjectModal } = await loadProjectModal();
    await act(async () => {
      root?.render(<ProjectModal />);
      await Promise.resolve();
    });
  };

  it('creates a new global project from a local folder', async () => {
    await renderModal();

    await changeInput('e.g. Mobile App Suite', 'Suite');
    await changeInput('e.g. C:/dev/mobile-suite/backend', 'C:/work/app');

    await act(async () => {
      findButton('Create project').click();
      await Promise.resolve();
    });

    expect(previewProjectGitSetupMock).toHaveBeenCalledWith({ path: 'C:/work/app' });
    expect(createProjectMock).toHaveBeenCalledWith({
      name: 'app',
      description: '',
      groupId: null,
      groupName: 'Suite',
      path: 'C:/work/app',
    });
    expect(closeProjectModalMock).toHaveBeenCalled();
  });

  it('blocks duplicate folder paths before previewing Git setup', async () => {
    useAppStore.setState({
      projectGroups: [
        buildProjectGroup({
          projects: [buildProject({ name: 'API', path: 'C:/work/api' })],
        }),
      ],
    });
    await renderModal();

    await changeInput('e.g. Mobile App Suite', 'Suite');
    await changeInput('e.g. C:/dev/mobile-suite/backend', 'c:/work/api/');

    await act(async () => {
      findButton('Create project').click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('This folder is already attached to "API"');
    expect(previewProjectGitSetupMock).not.toHaveBeenCalled();
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it('requires an existing group selection before adding a subproject', async () => {
    await renderModal();

    await act(async () => {
      findButton('Existing project').click();
      await Promise.resolve();
    });
    await changeInput('e.g. C:/dev/mobile-suite/backend', 'C:/work/api');

    await act(async () => {
      findButton('Add subproject').click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Choose an existing global project first');
    expect(previewProjectGitSetupMock).not.toHaveBeenCalled();
  });

  it('opens rare Git Flow confirmation and persists confirmed branch roles', async () => {
    previewProjectGitSetupMock = mock(async (_data: { path: string }) =>
      buildDetection({
        repoDetected: true,
        branches: ['release/v1'],
        currentBranch: 'integration',
        suggestedMainBranch: 'production',
        suggestedBaseBranch: 'integration',
        requiresConfirmation: true,
        setupState: 'needs_branch_confirmation',
      })
    );
    await renderModal();

    await changeInput('e.g. Mobile App Suite', 'Suite');
    await changeInput('e.g. C:/dev/mobile-suite/backend', 'C:/work/app');

    await act(async () => {
      findButton('Create project').click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Confirm branch roles');

    await act(async () => {
      findButton('Confirm and save').click();
      await Promise.resolve();
    });

    expect(createProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app',
        gitFlowSettings: expect.objectContaining({
          mainBranch: 'production',
          baseBranch: 'integration',
        }),
      })
    );
  });

  it('runs accepted Git setup prompts through createProjectWithGitSetup', async () => {
    previewProjectGitSetupMock = mock(async (_data: { path: string }) =>
      buildDetection({
        repoDetected: false,
        setupState: 'not_git',
        repoResolution: 'new_local_repo',
        resolvedRepoRootPath: 'C:/work/app',
        recommendedActionSequence: ['initialize_repo'],
      })
    );
    await renderModal();

    await changeInput('e.g. Mobile App Suite', 'Suite');
    await changeInput('e.g. C:/dev/mobile-suite/backend', 'C:/work/app');

    await act(async () => {
      findButton('Create project').click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Initialize Git?');

    await act(async () => {
      findButton('Initialize Git').click();
      await Promise.resolve();
    });

    expect(createProjectWithGitSetupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app',
        path: 'C:/work/app',
        gitSetupActions: ['initialize_repo'],
        expectedRepoRootPath: 'C:/work/app',
        expectedSetupState: 'not_git',
        expectedRecommendedActionSequence: ['initialize_repo'],
      })
    );
  });

  it('declines Git setup prompts and persists the read-only project', async () => {
    previewProjectGitSetupMock = mock(async (_data: { path: string }) =>
      buildDetection({
        repoDetected: false,
        setupState: 'not_git',
        repoResolution: 'new_local_repo',
        recommendedActionSequence: ['initialize_repo'],
      })
    );
    await renderModal();

    await changeInput('e.g. Mobile App Suite', 'Suite');
    await changeInput('e.g. C:/dev/mobile-suite/backend', 'C:/work/app');

    await act(async () => {
      findButton('Create project').click();
      await Promise.resolve();
    });

    await act(async () => {
      findButton('Keep read-only').click();
      await Promise.resolve();
    });

    expect(createProjectMock).toHaveBeenCalledWith({
      name: 'app',
      description: '',
      groupId: null,
      groupName: 'Suite',
      path: 'C:/work/app',
    });
    expect(createProjectWithGitSetupMock).not.toHaveBeenCalled();
  });
});
