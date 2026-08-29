import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAppStore } from '../../stores/useAppStore';
import type { ArchitectPlanSummary } from '../../services/architectPlanService';
import type { MacroProjectMetadataLoadResult } from '../../services/macroProjectMetadataLoader';
import { ArchitectProjectNavigator } from './ArchitectProjectNavigator';

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  await Promise.resolve();
};

const plan = (id: string, title: string): ArchitectPlanSummary => ({
  id,
  slug: id,
  title,
  description: '',
  status: 'draft',
  targetBranch: 'develop',
  projectId: 'project-1',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  nodeCount: 0,
});

describe('ArchitectProjectNavigator search', () => {
  const initialAppState = useAppStore.getState();
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    window.localStorage.clear();
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
    container = null;
    root = null;
    useAppStore.setState(initialAppState, true);
  });

  it('searches only plans and activates the selected result', async () => {
    const matchingPlan = plan('deployment', 'Préparer le déploiement');
    const otherPlan = plan('navigation', 'Réparer la navigation');
    const archivedPlan = {
      ...plan('archived-deployment', 'Déploiement archivé'),
      status: 'archived' as const,
      archivedAt: '2026-08-02T00:00:00.000Z',
    };
    const activateArchitectPlan = mock(async () => true);
    useAppStore.setState({
      ...useAppStore.getState(),
      standaloneProjects: [{
        id: 'project-1',
        name: 'Macro',
        path: 'C:/repo/Macro',
      }] as never,
      projectGroups: [],
      selectedGroupId: null,
      selectedProjectId: 'project-1',
      activeArchitectPlanId: null,
      activePlanContext: null,
      activateArchitectPlan: activateArchitectPlan as never,
    });

    const catalogLoader = mock(async (): Promise<MacroProjectMetadataLoadResult> => ({
      snapshot: {
        branchCatalogByBranch: {},
        branches: [{
          branchName: 'develop',
          activePlanId: null,
          plans: [matchingPlan, otherPlan, archivedPlan],
          error: null,
        }],
        scannedBranchNames: ['develop'],
        scopedProjectIds: ['project-1'],
        visiblePlans: [matchingPlan, otherPlan, archivedPlan],
        modernPlanCount: 3,
        selectedPlan: null,
        selectedBranchName: null,
        selectionReason: 'none',
        errors: [],
      },
      selectedPlan: null,
      selectedBranchName: null,
      selectionReason: 'none',
    }));

    await act(async () => {
      root?.render(<ArchitectProjectNavigator catalogLoader={catalogLoader} />);
      await flushRender();
    });

    expect(document.body.querySelector('[data-tour-id="architect-plan-search"]')).toBeNull();
    const searchToggle = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="architect-search-toggle"]'
    );
    expect(searchToggle?.className).toContain('h-7 w-7');
    await act(async () => {
      searchToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    let searchInput = document.body.querySelector<HTMLInputElement>(
      '[data-tour-id="architect-plan-search"] input'
    );
    expect(searchInput?.closest('.h-12')).not.toBeNull();
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      valueSetter?.call(searchInput, 'DEPLOIEMENT');
      searchInput?.dispatchEvent(new window.Event('input', { bubbles: true }));
      await flushRender();
    });

    expect(document.body.textContent).toContain('Préparer le déploiement');
    expect(document.body.textContent).not.toContain('Réparer la navigation');
    expect(document.body.textContent).not.toContain('Déploiement archivé');

    const result = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Préparer le déploiement'));
    await act(async () => {
      result?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });

    expect(activateArchitectPlan).toHaveBeenCalledWith('deployment', {
      targetBranch: 'develop',
      planSummaryHint: matchingPlan,
      scopedProjectIdsHint: ['project-1'],
      persistActiveSelection: true,
    });

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-tour-id="architect-search-toggle"]')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });
    const archiveToggle = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="architect-archive-toggle"]'
    );
    await act(async () => {
      archiveToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
      document.body.querySelector<HTMLButtonElement>('[data-tour-id="architect-search-toggle"]')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flushRender();
    });
    searchInput = document.body.querySelector<HTMLInputElement>(
      '[data-tour-id="architect-plan-search"] input'
    );
    await act(async () => {
      valueSetter?.call(searchInput, 'DEPLOIEMENT');
      searchInput?.dispatchEvent(new window.Event('input', { bubbles: true }));
      await flushRender();
    });
    expect(document.body.textContent).toContain('Déploiement archivé');
    expect(document.body.textContent).not.toContain('Préparer le déploiement');

    await act(async () => {
      valueSetter?.call(searchInput, 'conversation');
      searchInput?.dispatchEvent(new window.Event('input', { bubbles: true }));
      await flushRender();
    });
    expect(document.body.textContent).toContain('Aucun plan ne correspond à cette recherche.');
  });
});
