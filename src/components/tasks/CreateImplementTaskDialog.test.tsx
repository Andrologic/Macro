import React from 'react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let availableStartPoints = {
  worktrees: [] as Array<{ name: string; path: string; branchName: string; isDirty: boolean }>,
  branches: [] as Array<{ name: string; commit: string }>,
};
let currentStatus = {
  branch: 'develop',
  head_commit: { hash: '0123456789abcdef' },
  is_clean: true,
};

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

mock.module('../ui/Dialog', () => ({
  Dialog: ({ children, panelClassName }: { children: React.ReactNode; panelClassName?: string }) => (
    <div data-panel-class={panelClassName}>{children}</div>
  ),
}));

mock.module('../../services/tauriIpc', () => ({
  gitTaskStartPoints: async () => availableStartPoints,
  gitStatus: async () => currentStatus,
}));

import { CreateImplementTaskDialog } from './CreateImplementTaskDialog';
import type { TaskProjectFilterOption } from './TaskProjectFilter';

const project = (
  id: string,
  name: string,
  baseBranch: string,
  mainBranch: string,
): TaskProjectFilterOption => ({
  id,
  name,
  path: `/repo/${id}`,
  groupName: null,
  taskCount: 0,
  isReadOnly: false,
  gitFlowSettings: {
    baseBranch,
    mainBranch,
    planBranchTemplate: 'plan/{planSlug}',
    featureBranchTemplate: 'feature/{planSlug}/{featureSlug}',
    standaloneFeatureBranchTemplate: 'feature/{featureSlug}',
    releaseBranchTemplate: 'release/{releaseSlug}',
    hotfixBranchTemplate: 'hotfix/{hotfixSlug}',
    bugfixBranchTemplate: 'bugfix/{bugfixSlug}',
  },
});

describe('CreateImplementTaskDialog task type help', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    availableStartPoints = { worktrees: [], branches: [] };
    currentStatus = {
      branch: 'develop',
      head_commit: { hash: '0123456789abcdef' },
      is_clean: true,
    };
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('describes every available task type for pointer and keyboard users', async () => {
    await act(async () => {
      root.render(
        <CreateImplementTaskDialog
          projects={[project('develop', 'Develop project', 'develop', 'main')]}
          initialProjectId="develop"
          isCreating={false}
          onClose={() => undefined}
          onCreate={() => undefined}
        />
      );
    });

    const expected = {
      Feature: 'Feature creates a branch from the configured development branch and merges it back into that branch.',
      Bugfix: 'Bugfix creates a branch from the configured development branch and merges it back into that branch.',
      Hotfix: 'Hotfix creates a branch from the configured production branch and merges it back into that branch.',
      Direct: 'Work in the project folder without a dedicated branch or worktree. Accepted changes are committed to the current branch.',
    };

    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('[data-task-kind-available]'))
        .map((button) => button.textContent?.trim())
    ).toEqual(['Direct', 'Feature', 'Bugfix', 'Hotfix']);

    for (const [label, description] of Object.entries(expected)) {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim().startsWith(label)
      );
      expect(button, label).toBeDefined();

      const descriptionId = button?.getAttribute('aria-describedby');
      expect(descriptionId, `${label} keyboard description`).toBeTruthy();
      expect(container.querySelector(`#${descriptionId}`)?.textContent).toBe(description);
    }

    const buttons = Object.fromEntries(
      Object.keys(expected).map((label) => [
        label,
        Array.from(container.querySelectorAll('button')).find(
          (candidate) => candidate.textContent?.trim() === label
        ) as HTMLButtonElement,
      ])
    );

    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true,
      clientX: 100,
      clientY: 120,
    })));
    const pointerTooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(pointerTooltip?.textContent).toBe(expected.Feature);
    expect(container.contains(pointerTooltip)).toBe(false);
    expect(pointerTooltip?.style.left).toBe('112px');
    expect(pointerTooltip?.style.top).toBe('132px');

    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: 180,
      clientY: 200,
    })));
    expect(document.body.querySelector<HTMLElement>('[role="tooltip"]')?.style.left).toBe('192px');
    expect(document.body.querySelector<HTMLElement>('[role="tooltip"]')?.style.top).toBe('212px');

    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    buttons.Hotfix.getBoundingClientRect = () => ({
      left: 120,
      top: 80,
      right: 220,
      bottom: 120,
      width: 100,
      height: 40,
      x: 120,
      y: 80,
      toJSON: () => ({}),
    });
    await act(async () => buttons.Hotfix.focus());
    const focusTooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(focusTooltip?.textContent).toBe(expected.Hotfix);
    expect(focusTooltip?.style.left).toBe('120px');
    expect(focusTooltip?.style.top).toBe('132px');
    await act(async () => {
      buttons.Feature.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true,
        clientX: 180,
        clientY: 200,
      }));
      buttons.Feature.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(expected.Hotfix);
    await act(async () => buttons.Hotfix.blur());
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true,
      clientX: 795,
      clientY: 595,
    })));
    const constrainedTooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(constrainedTooltip?.style.left).toBe('463px');
    expect(constrainedTooltip?.style.top).toBe('503px');
    await act(async () => buttons.Feature.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));

    await act(async () => {
      buttons.Bugfix.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      buttons.Bugfix.click();
      buttons.Bugfix.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('creates a Direct task on the current branch without a worktree start point', async () => {
    const onCreate = mock(() => undefined);
    await act(async () => {
      root.render(
        <CreateImplementTaskDialog
          projects={[project('develop', 'Develop project', 'develop', 'main')]}
          initialProjectId="develop"
          isCreating={false}
          onClose={() => undefined}
          onCreate={onCreate}
        />
      );
    });
    await act(async () => Promise.resolve());

    const findButton = (label: string) => Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === label,
    ) as HTMLButtonElement;
    await act(async () => findButton('Direct').click());
    expect(container.textContent).not.toContain('Starting point');
    await act(async () => findButton('Create task').click());

    expect(onCreate).toHaveBeenCalledWith({
      projectId: 'develop',
      taskKind: 'direct',
      startPoint: {
        kind: 'direct',
        branchName: 'develop',
        baseCommitHash: '0123456789abcdef',
      },
    });
  });

  it('recomputes task type availability from the selected project workflow', async () => {
    const onCreate = mock(() => undefined);
    await act(async () => {
      root.render(
        <CreateImplementTaskDialog
          projects={[
            project('develop', 'Develop project', 'develop', 'main'),
            project('mainline', 'Mainline project', 'main', 'main'),
          ]}
          initialProjectId="develop"
          isCreating={false}
          onClose={() => undefined}
          onCreate={onCreate}
        />
      );
    });

    const findButton = (label: string) => Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === label,
    ) as HTMLButtonElement;
    const bugfixButton = findButton('Bugfix');
    const featureButton = findButton('Feature');
    const hotfixButton = findButton('Hotfix');
    const createButton = findButton('Create task');

    expect(featureButton.getAttribute('aria-disabled')).toBe('false');
    expect(bugfixButton.getAttribute('aria-disabled')).toBe('false');
    expect(hotfixButton.getAttribute('aria-disabled')).toBe('false');

    await act(async () => bugfixButton.click());
    expect(bugfixButton.getAttribute('aria-pressed')).toBe('true');
    expect(createButton.disabled).toBe(false);

    const mainlineProjectButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Mainline project'),
    ) as HTMLButtonElement;
    await act(async () => mainlineProjectButton.click());
    expect(featureButton.getAttribute('aria-disabled')).toBe('false');
    expect(bugfixButton.getAttribute('aria-disabled')).toBe('true');
    expect(hotfixButton.getAttribute('aria-disabled')).toBe('false');
    expect(bugfixButton.getAttribute('aria-pressed')).toBe('false');
    expect(createButton.disabled).toBe(true);

    await act(async () => bugfixButton.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true,
      clientX: 100,
      clientY: 120,
    })));
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Bugfix requires a development branch distinct from the production branch. This project uses a mainline workflow.',
    );
    await act(async () => bugfixButton.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));

    await act(async () => hotfixButton.click());
    expect(createButton.disabled).toBe(false);
    await act(async () => createButton.click());
    expect(onCreate).toHaveBeenCalledWith({
      projectId: 'mainline',
      taskKind: 'hotfix',
      startPoint: { kind: 'new' },
    });
  });

  it('groups resumable worktrees and branches and returns the selected branch', async () => {
    availableStartPoints = {
      worktrees: [{
        name: 'external-worktree',
        path: '/worktrees/external',
        branchName: 'feature/in-editor',
        isDirty: true,
      }],
      branches: [{ name: 'feature/without-worktree', commit: 'abc1234' }],
    };
    const onCreate = mock(() => undefined);
    await act(async () => {
      root.render(
        <CreateImplementTaskDialog
          projects={[project('develop', 'Develop project', 'develop', 'main')]}
          initialProjectId="develop"
          isCreating={false}
          onClose={() => undefined}
          onCreate={onCreate}
        />
      );
    });
    await act(async () => Promise.resolve());

    const findButton = (text: string) => Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes(text),
    ) as HTMLButtonElement;
    const compactPanelClass = container.firstElementChild?.getAttribute('data-panel-class');
    expect(compactPanelClass).toContain('h-[min(46rem,calc(100vh-2rem))]');
    expect(compactPanelClass).toContain('duration-300');
    expect(container.querySelector('[aria-label="Target project"]')?.className).toContain('flex-1');
    expect(container.textContent).not.toContain('Choose the target project and the task type.');
    expect(container.textContent).not.toContain('A project is required.');
    expect(findButton('Resume work').textContent).toContain(
      'Reuse a worktree or create one from an existing branch.'
    );
    expect(container.querySelector('aside')).toBeNull();
    await act(async () => findButton('Resume work').click());
    const resumePanel = container.querySelector('aside[aria-label="Resume work"]');
    expect(resumePanel).not.toBeNull();
    const expandedPanelClass = container.firstElementChild?.getAttribute('data-panel-class');
    expect(expandedPanelClass).toContain('max-w-5xl');
    expect(expandedPanelClass).toContain('h-[min(46rem,calc(100vh-2rem))]');
    expect(container.textContent).toContain('Existing worktrees');
    expect(container.textContent).toContain('Branches without a worktree');
    expect(container.textContent).toContain('feature/in-editor');
    expect(container.textContent).toContain('feature/without-worktree');

    await act(async () => findButton('feature/without-worktree').click());
    await act(async () => findButton('Feature').click());
    await act(async () => findButton('Create task').click());
    expect(onCreate).toHaveBeenCalledWith({
      projectId: 'develop',
      taskKind: 'feature',
      startPoint: {
        kind: 'branch',
        branch: { name: 'feature/without-worktree', commit: 'abc1234' },
      },
    });
  });
});
