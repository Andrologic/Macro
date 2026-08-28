import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAppStore } from '../../stores/useAppStore';
import type { Project, ProjectGitFlowDetection } from '../../types';

let importCounter = 0;
const previewProjectGitSetupMock = mock(async (): Promise<ProjectGitFlowDetection> => ({
  repoDetected: true,
  branches: ['main'],
  currentBranch: 'main',
  suggestedMainBranch: 'main',
  suggestedBaseBranch: 'main',
  suggestedCommitBranch: 'main',
  requiresConfirmation: false,
  setupState: 'ready',
  hasInitialCommit: true,
  resolvedRepoRootPath: 'C:/work/project',
  repoResolution: 'selected_folder',
  initialCommitPreviewPaths: [],
  initialCommitPreviewCount: 0,
  initialCommitRiskFlags: [],
  recommendedActionSequence: [],
}));
const updateProjectGitFlowWithSetupMock = mock(async () => ({
  project: {} as Project,
  detection: await previewProjectGitSetupMock(),
}));

const project: Project = {
  id: 'project-1',
  name: 'Project',
  mountName: 'project',
  path: 'C:/work/project',
  created_at: '2026-08-28T00:00:00.000Z',
  status: 'active',
  gitSetupState: 'unknown',
  isReadOnly: true,
  metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
};

const loadModal = async () => {
  mock.restore();
  importCounter += 1;
  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (_key: string, fallback: string, options?: Record<string, unknown>) =>
        fallback.replace(/\{\{(\w+)\}\}/g, (_match, key) => String(options?.[key] ?? '')),
    }),
  }));
  mock.module('../../services', () => ({
    services: {
      previewProjectGitSetup: previewProjectGitSetupMock,
    },
  }));
  mock.module('../ui/toastService', () => ({
    notify: {
      success: mock(() => undefined),
      error: mock(() => undefined),
    },
  }));
  return import(`./ProjectGitFlowModal.tsx?test=${importCounter}`);
};

describe('ProjectGitFlowModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    previewProjectGitSetupMock.mockClear();
    updateProjectGitFlowWithSetupMock.mockClear();
    useAppStore.setState({
      projectGitFlowModalProjectId: project.id,
      getProjectById: (projectId: string) => projectId === project.id ? project : undefined,
      updateProjectGitFlow: mock(async () => undefined),
      updateProjectGitFlowWithSetup: updateProjectGitFlowWithSetupMock,
      updateProjectAccess: mock(async () => undefined),
      closeProjectGitFlowModal: mock(() => undefined),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    mock.restore();
  });

  it('persists a ready Git detection even when no setup prompt is required', async () => {
    const { ProjectGitFlowModal } = await loadModal();
    await act(async () => root.render(<ProjectGitFlowModal />));
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Check Git status',
    );
    expect(button).toBeDefined();

    await act(async () => {
      button!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewProjectGitSetupMock).toHaveBeenCalledWith({ path: project.path });
    expect(updateProjectGitFlowWithSetupMock).toHaveBeenCalledWith(
      project.id,
      expect.any(Object),
      [],
      project.path,
      'ready',
      [],
    );
  });
});
