import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAppStore } from '../../stores/useAppStore';
import type { Project, ProjectAccessChangePreview, ProjectGitFlowDetection } from '../../types';

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

const accessPreview: ProjectAccessChangePreview = {
  projectId: 'project-1',
  targetReadOnly: true,
  canApply: true,
  requiresConfirmation: true,
  blockingReasons: [],
  migrationSummary: {
    plans: { count: 1, labels: ['Plan'] },
    manualFeatures: { count: 0, labels: [] },
    tasks: { count: 1, labels: ['Task'] },
    worktrees: { count: 0, labels: [] },
    predictedBranches: { count: 0, labels: [] },
    planNodes: { count: 0, labels: [] },
    executionTargets: { count: 1, labels: ['Project'] },
  },
};
const previewProjectAccessChangeMock = mock(async () => accessPreview);

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
      previewProjectAccessChange: previewProjectAccessChangeMock,
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
    previewProjectAccessChangeMock.mockClear();
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

  it('names every Git setting and blocks invalid branches before saving', async () => {
    const { ProjectGitFlowModal } = await loadModal();
    await act(async () => root.render(<ProjectGitFlowModal />));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const labels = Array.from(dialog.querySelectorAll('label'));
    expect(labels.length).toBeGreaterThan(2);
    for (const label of labels) {
      expect(label.htmlFor).not.toBe('');
      expect(document.getElementById(label.htmlFor)).not.toBeNull();
    }
    const targetLabel = labels.find(label => label.textContent?.includes('Development'))!;
    const target = document.getElementById(targetLabel.htmlFor) as HTMLInputElement;
    for (const value of ['branch invalid', 'topic..bad', 'topic.lock', 'topic@{1}', '/topic', '-topic', '']) {
      const propsKey = Object.keys(target).find(key => key.startsWith('__reactProps$'))!;
      const props = (target as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey];
      await act(async () => props.onChange({ target: { value } }));
      expect(target.getAttribute('aria-invalid')).toBe('true');
      expect(document.getElementById(target.getAttribute('aria-describedby')!)?.textContent).toBe('Enter a valid Git branch name.');
      const save = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Validate')!;
      expect(save.disabled).toBe(true);
      await act(async () => save.click());
    }
    expect(useAppStore.getState().updateProjectGitFlow).not.toHaveBeenCalled();
    expect(useAppStore.getState().closeProjectGitFlowModal).not.toHaveBeenCalled();
  });

  it('contains focus, closes on Escape and restores the opener', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { ProjectGitFlowModal } = await loadModal();
    await act(async () => root.render(<ProjectGitFlowModal />));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
    buttons[buttons.length - 1].focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(useAppStore.getState().closeProjectGitFlowModal).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });


  it('restores the access trigger after a deferred preview is cancelled and can reopen it', async () => {
    const editableProject: Project = { ...project, gitSetupState: 'ready', isReadOnly: false, userReadOnly: false };
    useAppStore.setState({ getProjectById: () => editableProject });
    const { ProjectGitFlowModal } = await loadModal();
    await act(async () => root.render(<ProjectGitFlowModal />));
    const parent = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const trigger = Array.from(parent.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === 'Make read-only')!;

    for (const cancellation of ['Escape', 'Cancel']) {
      let resolvePreview!: (value: ProjectAccessChangePreview) => void;
      previewProjectAccessChangeMock.mockImplementationOnce(() => new Promise(resolve => {
        resolvePreview = resolve;
      }));
      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      // Happy DOM does not perform the browser's Enter default action; click uses the public DOM API.
      await act(async () => trigger.click());
      expect(trigger.disabled).toBe(true);
      expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      // Happy DOM also ignores blur() on disabled buttons. Simulate native focus loss with
      // public DOM APIs only; the transient enabling is test-only and runs without any click.
      if (document.activeElement === trigger) {
        trigger.disabled = false;
        trigger.blur();
        trigger.disabled = true;
      }
      expect(document.activeElement === document.body).toBe(true);
      expect(trigger.disabled).toBe(true);

      await act(async () => resolvePreview(accessPreview));
      expect(trigger.disabled).toBe(false);
      const dialogs = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
      expect(dialogs).toHaveLength(2);
      expect(dialogs[0]).toBe(parent);
      expect(parent.parentElement?.hasAttribute('inert')).toBe(true);
      const childButtons = dialogs[1].querySelectorAll<HTMLButtonElement>('button:not([disabled])');
      childButtons[0].focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(childButtons[childButtons.length - 1]);

      await act(async () => {
        if (cancellation === 'Escape') {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        } else {
          childButtons[0].click();
        }
      });
      expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect([document.activeElement === trigger, document.activeElement?.getAttribute('aria-label')]).toEqual([true, null]);
      expect(parent.parentElement?.hasAttribute('inert')).toBe(false);
      expect(useAppStore.getState().getProjectById(project.id)).toBe(editableProject);
      expect(useAppStore.getState().updateProjectAccess).not.toHaveBeenCalled();
      expect(useAppStore.getState().closeProjectGitFlowModal).not.toHaveBeenCalled();
    }
    expect(previewProjectAccessChangeMock).toHaveBeenCalledTimes(2);
    expect(previewProjectAccessChangeMock).toHaveBeenCalledWith({ projectId: project.id, targetReadOnly: true });
  });

  it('persists a ready Git detection even when no setup prompt is required', async () => {
    const { ProjectGitFlowModal } = await loadModal();
    await act(async () => root.render(<ProjectGitFlowModal />));
    const button = Array.from(document.body.querySelectorAll('button')).find(
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
