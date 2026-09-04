import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAppStore } from '../../stores/useAppStore';
import type { ArchitectPlanSummary } from '../../services/architectPlanService';
import type { MacroProjectMetadataLoadResult } from '../../services/macroProjectMetadataLoader';
import { ArchitectProjectNavigator } from './ArchitectProjectNavigator';
import {
  DEFAULT_ARCHITECT_VIEW_FILTERS,
} from '../../services/viewFilterPreferences';
import { useViewFilterStore } from '../../stores/useViewFilterStore';
import { dispatchArchitectPlanSelectorRequest } from './planSelectorEvents';

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
    useViewFilterStore.setState({
      architect: { ...DEFAULT_ARCHITECT_VIEW_FILTERS },
      isHydrated: true,
    });
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
        gitSetupState: 'ready',
        directEdit: false,
        isReadOnly: false,
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
    const header = searchInput?.closest('.h-12');
    const openSearchToggle = document.body.querySelector<HTMLButtonElement>(
      '[data-tour-id="architect-search-toggle"]'
    );
    const searchBar = document.body.querySelector<HTMLElement>(
      '[data-tour-id="architect-plan-search"]'
    );
    expect(header).not.toBeNull();
    expect(header?.className).toContain('gap-2');
    expect(openSearchToggle?.className).toContain('h-8 w-8');
    expect(searchBar?.className).toContain('focus-within:border-border');
    expect(searchBar?.className).toContain('focus-within:ring-0');
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

    await act(async () => {
      window.dispatchEvent(new CustomEvent('macro:architect-plan-selector-request', {
        detail: {
          action: 'primary',
          anchorRect: {
            top: 300,
            right: 740,
            bottom: 336,
            left: 600,
            width: 140,
            height: 36,
          },
        },
      }));
      await flushRender();
    });

    expect(document.body.querySelector('[data-architect-scope-create-menu]')).toBeNull();
  });

  it('opens project management when the selected empty scope is not editable', async () => {
    const openProjectNavigator = mock(() => undefined);
    useAppStore.setState({
      ...useAppStore.getState(),
      standaloneProjects: [{
        id: 'project-1',
        name: 'Macro',
        path: 'C:/repo/Macro',
        gitSetupState: 'not_git',
        directEdit: false,
        isReadOnly: true,
      }] as never,
      projectGroups: [],
      selectedGroupId: null,
      selectedProjectId: 'project-1',
      activeArchitectPlanId: null,
      activePlanContext: null,
      openProjectNavigator,
    });

    const catalogLoader = mock(async (): Promise<MacroProjectMetadataLoadResult> => ({
      snapshot: {
        branchCatalogByBranch: {},
        branches: [],
        scannedBranchNames: [],
        scopedProjectIds: ['project-1'],
        visiblePlans: [],
        modernPlanCount: 0,
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

    await act(async () => {
      window.dispatchEvent(new CustomEvent('macro:architect-plan-selector-request', {
        detail: { action: 'primary' },
      }));
      await flushRender();
    });

    expect(openProjectNavigator).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-architect-scope-create-menu]')).toBeNull();
  });

  it('opens the compatible plan-kind menu for an editable empty scope', async () => {
    useAppStore.setState({
      ...useAppStore.getState(),
      standaloneProjects: [{
        id: 'project-1',
        name: 'Macro',
        path: 'C:/repo/Macro',
        gitSetupState: 'ready',
        directEdit: false,
        isReadOnly: false,
      }] as never,
      projectGroups: [],
      selectedGroupId: null,
      selectedProjectId: 'project-1',
      activeArchitectPlanId: null,
      activePlanContext: null,
    });

    const catalogLoader = mock(async (): Promise<MacroProjectMetadataLoadResult> => ({
      snapshot: {
        branchCatalogByBranch: {},
        branches: [],
        scannedBranchNames: [],
        scopedProjectIds: ['project-1'],
        visiblePlans: [],
        modernPlanCount: 0,
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

    await act(async () => {
      window.dispatchEvent(new CustomEvent('macro:architect-plan-selector-request', {
        detail: {
          action: 'primary',
          anchorRect: {
            top: 300,
            right: 740,
            bottom: 336,
            left: 600,
            width: 140,
            height: 36,
          },
        },
      }));
      await flushRender();
    });

    const menu = document.body.querySelector('[data-architect-scope-create-menu]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('Feature');
  });

  it('publishes an error when the catalog is only partially loaded', async () => {
    useAppStore.setState({
      ...useAppStore.getState(),
      standaloneProjects: [{
        id: 'project-1',
        name: 'Macro',
        path: 'C:/repo/Macro',
        gitSetupState: 'ready',
        directEdit: false,
        isReadOnly: false,
      }] as never,
      projectGroups: [],
      selectedGroupId: null,
      selectedProjectId: 'project-1',
      activeArchitectPlanId: null,
      activePlanContext: null,
    });

    const catalogLoader = mock(async (): Promise<MacroProjectMetadataLoadResult> => ({
      snapshot: {
        branchCatalogByBranch: {},
        branches: [{
          branchName: 'develop',
          activePlanId: null,
          plans: [],
          error: null,
        }, {
          branchName: 'release/0.1.4',
          activePlanId: null,
          plans: [],
          error: 'metadata unavailable',
        }],
        scannedBranchNames: ['develop', 'release/0.1.4'],
        scopedProjectIds: ['project-1'],
        visiblePlans: [],
        modernPlanCount: 0,
        selectedPlan: null,
        selectedBranchName: null,
        selectionReason: 'none',
        errors: [{ branchName: 'release/0.1.4', message: 'metadata unavailable' }],
      },
      selectedPlan: null,
      selectedBranchName: null,
      selectionReason: 'none',
    }));
    const publishedStates: Array<{ status: string }> = [];
    const handleState = (event: Event) => {
      publishedStates.push((event as CustomEvent<{ status: string }>).detail);
    };
    window.addEventListener('macro:architect-plan-selector-state', handleState);

    try {
      await act(async () => {
        root?.render(<ArchitectProjectNavigator catalogLoader={catalogLoader} />);
        await flushRender();
      });

      expect(document.body.textContent).toContain('Impossible de charger les plans.');
      expect(publishedStates.at(-1)?.status).toBe('error');
      expect(document.body.querySelector('[data-architect-scope-create-menu]')).toBeNull();
      expect(document.body.querySelector<HTMLButtonElement>('button[aria-label="Nouveau plan pour Macro"]')?.disabled).toBe(true);
      const firstPlanButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Créer le premier plan'));
      expect(firstPlanButton?.disabled).toBe(true);
    } finally {
      window.removeEventListener('macro:architect-plan-selector-state', handleState);
    }
  });

  it('waits for the catalog before replaying a deferred primary request', async () => {
    useAppStore.setState({
      ...useAppStore.getState(),
      standaloneProjects: [{
        id: 'project-1',
        name: 'Macro',
        path: 'C:/repo/Macro',
        gitSetupState: 'ready',
        directEdit: false,
        isReadOnly: false,
      }] as never,
      projectGroups: [],
      selectedGroupId: null,
      selectedProjectId: 'project-1',
      activeArchitectPlanId: null,
      activePlanContext: null,
    });

    const existingPlan = plan('existing-plan', 'Plan existant');
    let resolveCatalog: ((result: MacroProjectMetadataLoadResult) => void) | null = null;
    const catalogLoader = mock(() => new Promise<MacroProjectMetadataLoadResult>((resolve) => {
      resolveCatalog = resolve;
    }));

    dispatchArchitectPlanSelectorRequest({ action: 'primary' });
    await act(async () => {
      root?.render(<ArchitectProjectNavigator catalogLoader={catalogLoader} />);
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-architect-scope-create-menu]')).toBeNull();

    await act(async () => {
      resolveCatalog?.({
        snapshot: {
          branchCatalogByBranch: {},
          branches: [{
            branchName: 'develop',
            activePlanId: null,
            plans: [existingPlan],
            error: null,
          }],
          scannedBranchNames: ['develop'],
          scopedProjectIds: ['project-1'],
          visiblePlans: [existingPlan],
          modernPlanCount: 1,
          selectedPlan: null,
          selectedBranchName: null,
          selectionReason: 'none',
          errors: [],
        },
        selectedPlan: null,
        selectedBranchName: null,
        selectionReason: 'none',
      });
      await flushRender();
    });

    expect(document.body.textContent).toContain('Plan existant');
    expect(document.body.querySelector('[data-architect-scope-create-menu]')).toBeNull();
  });
});
