import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAppStore } from '../../stores/useAppStore';
import { toPlanLocatorKey } from '../../services/durableIdentity';
import type { ArchitectPlanRecord, ArchitectPlanSummary } from '../../services/architectPlanService';
import type { MacroProjectMetadataLoadResult } from '../../services/macroProjectMetadataLoader';
import { ArchitectProjectNavigator } from './ArchitectProjectNavigator';
import {
  DEFAULT_ARCHITECT_VIEW_FILTERS,
} from '../../services/viewFilterPreferences';
import { useViewFilterStore } from '../../stores/useViewFilterStore';
import { dispatchArchitectPlanSelectorRequest } from './planSelectorEvents';
import { nameBlueprintFolder, moveBlueprintToFolder, emptyBlueprintFolders } from '../../services/blueprintFolders';
import { PREF_KEYS, savePreference, loadPreference } from '../../services/preferences';

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

  beforeEach(async () => {
    useViewFilterStore.setState({
      architect: { ...DEFAULT_ARCHITECT_VIEW_FILTERS },
      isHydrated: true,
    });
    window.localStorage.clear();
    await savePreference(PREF_KEYS.ARCHITECT_NAVIGATOR_COLLAPSED_SECTIONS, []);
    await savePreference(PREF_KEYS.ARCHITECT_BLUEPRINT_FOLDERS, { folders: [], placements: {}, collapsedIds: [] });
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

  it('separates the shared library, activates its blueprints and remembers independent section folds', async () => {
    const shared = { ...plan('common', 'Common assistant'), projectId: 'macro-library' };
    const local = plan('local', 'Project blueprint');
    const activate = mock(async () => true);
    useAppStore.setState({ standaloneProjects: [
      { id: 'project-1', name: 'Sample project', path: '/demo/project', gitSetupState: 'ready' },
      { id: 'macro-library', name: 'Macro', path: '/demo/macro', gitSetupState: 'ready' },
    ] as never, projectGroups: [], selectedProjectId: 'project-1', selectedGroupId: null, activeArchitectPlanId: null, activePlanContext: null, activateArchitectPlan: activate as never });
    const catalogLoader = mock(async (): Promise<MacroProjectMetadataLoadResult> => ({
      snapshot: { branchCatalogByBranch: {}, branches: [{ branchName: 'develop', activePlanId: null, plans: [shared, local], error: null }], scannedBranchNames: ['develop'], scopedProjectIds: ['project-1', 'macro-library'], visiblePlans: [shared, local], modernPlanCount: 2, selectedPlan: null, selectedBranchName: null, selectionReason: 'none', errors: [] },
      selectedPlan: null, selectedBranchName: null, selectionReason: 'none',
    }));
    await act(async () => { root?.render(<ArchitectProjectNavigator macroBlueprintProjectId="macro-library" catalogLoader={catalogLoader} />); await flushRender(); });
    const library = document.querySelector('section[aria-label="Macro library"]')!;
    expect(library.textContent).toContain('Common assistant');
    expect(library.textContent).not.toContain('Project blueprint');
    const projects = document.querySelector('section[aria-labelledby="architect-projects-title"]')!;
    expect(projects.textContent).toContain('Sample project');
    expect(projects.textContent).not.toContain('Common assistant');
    expect(projects.textContent).not.toContain('Macro');
    const button = [...library.querySelectorAll('button')].find(button => button.textContent === 'Common assistant')!;
    await act(async () => { button.click(); await flushRender(); });
    expect(activate).toHaveBeenCalledWith('common', expect.objectContaining({ scopedProjectIdsHint: ['macro-library'] }));

    const macroToggle = () => container!.querySelector<HTMLButtonElement>('[aria-controls="architect-macro-blueprints-content"]')!;
    const projectsToggle = () => container!.querySelector<HTMLButtonElement>('[aria-controls="architect-projects-content"]')!;
    const macroContent = () => container!.querySelector<HTMLElement>('#architect-macro-blueprints-content')!;
    const projectsContent = () => container!.querySelector<HTMLElement>('#architect-projects-content')!;
    await act(async () => { macroToggle().click(); await flushRender(); });
    expect(macroToggle().getAttribute('aria-expanded')).toBe('false');
    expect(macroContent().hidden).toBe(true);
    expect(projectsContent().hidden).toBe(false);
    await act(async () => { projectsToggle().click(); macroToggle().click(); await flushRender(); });
    expect(macroContent().hidden).toBe(false);
    expect(projectsContent().hidden).toBe(true);
    await act(async () => { macroToggle().click(); await flushRender(); });
    expect(await loadPreference<string[]>(PREF_KEYS.ARCHITECT_NAVIGATOR_COLLAPSED_SECTIONS)).toEqual(['projects', 'macro']);

    // A remount restores both choices; search only reveals results temporarily.
    await act(async () => { root?.render(<div />); await flushRender(); });
    await act(async () => { root?.render(<ArchitectProjectNavigator macroBlueprintProjectId="macro-library" catalogLoader={catalogLoader} />); await flushRender(); });
    expect(macroContent().hidden).toBe(true);
    expect(projectsContent().hidden).toBe(true);
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-tour-id="architect-search-toggle"]')!.click();
      await flushRender();
    });
    const searchInput = container!.querySelector<HTMLInputElement>('[data-tour-id="architect-plan-search"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(searchInput, 'Common');
      searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      await flushRender();
    });
    expect(macroContent().hidden).toBe(false);
    expect(macroContent().textContent).toContain('Common assistant');
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-tour-id="architect-search-toggle"]')!.click();
      await flushRender();
    });
    expect(macroContent().hidden).toBe(true);
    expect(projectsContent().hidden).toBe(true);
    expect(await loadPreference<string[]>(PREF_KEYS.ARCHITECT_NAVIGATOR_COLLAPSED_SECTIONS)).toEqual(['projects', 'macro']);

  });

  it.each(['project', 'library'] as const)('creates folders, moves blueprints by drag and drop, and restores organization after remount in %s', async (scopeKind) => {
    const local = plan('local', 'Project blueprint');
    useAppStore.setState({ standaloneProjects: [{ id: 'project-1', name: 'Sample project', path: '/demo/project', gitSetupState: 'ready' }] as never, projectGroups: [], selectedProjectId: 'project-1', selectedGroupId: null, activeArchitectPlanId: null, activePlanContext: null });
    const catalogLoader = mock(async (): Promise<MacroProjectMetadataLoadResult> => ({
      snapshot: { branchCatalogByBranch: {}, branches: [{ branchName: 'develop', activePlanId: null, plans: [local], error: null }], scannedBranchNames: ['develop'], scopedProjectIds: ['project-1'], visiblePlans: [local], modernPlanCount: 1, selectedPlan: null, selectedBranchName: null, selectionReason: 'none', errors: [] },
      selectedPlan: null, selectedBranchName: null, selectionReason: 'none',
    }));
    await act(async () => { root?.render(<ArchitectProjectNavigator macroBlueprintProjectId={scopeKind === 'library' ? 'project-1' : undefined} catalogLoader={catalogLoader} />); await flushRender(); });
    const project = container!.querySelector<HTMLElement>('[data-architect-scope-id="project:project-1"]')!;
    await act(async () => {
      project.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click(); await flushRender();
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.includes('New folder'))!.click(); await flushRender();
    });
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Delivery');
      input.dispatchEvent(new window.Event('input', { bubbles: true })); await flushRender();
    });
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'Create')!.click(); await flushRender();
    });
    const folder = project.querySelector<HTMLElement>('[data-blueprint-folder]')!;
    expect(folder.textContent).toContain('Delivery');
    const values = new Map<string, string>();
    const transfer = { effectAllowed: 'none', dropEffect: 'none', setData: (type: string, value: string) => values.set(type, value), getData: (type: string) => values.get(type) ?? '' };
    const drag = (target: HTMLElement, type: string) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer }); target.dispatchEvent(event);
    };
    await act(async () => { drag(project.querySelector<HTMLElement>('[data-blueprint-locator]')!, 'dragstart'); await flushRender(); });
    await act(async () => { drag(folder, 'dragover'); drag(folder, 'drop'); await flushRender(); });
    expect(folder.querySelector('[data-blueprint-locator]')?.textContent).toContain('Project blueprint');
    expect(project.querySelectorAll('[data-blueprint-locator]')).toHaveLength(1);
    await act(async () => { root?.render(<div />); await flushRender(); });
    await act(async () => { root?.render(<ArchitectProjectNavigator macroBlueprintProjectId={scopeKind === 'library' ? 'project-1' : undefined} catalogLoader={catalogLoader} />); await flushRender(); });
    expect(container!.querySelector('[data-blueprint-folder] [data-blueprint-locator]')?.textContent).toContain('Project blueprint');
    const projectAfter = container!.querySelector<HTMLElement>('[data-architect-scope-id="project:project-1"]')!;
    await act(async () => { drag(projectAfter.querySelector<HTMLElement>('[data-blueprint-locator]')!, 'dragstart'); await flushRender(); });
    await act(async () => { drag(projectAfter.querySelector<HTMLElement>('[data-architect-scope-menu]')!, 'drop'); await flushRender(); });
    expect(projectAfter.querySelector('[data-blueprint-folder] [data-blueprint-locator]')).toBeNull();
    expect(projectAfter.querySelectorAll('[data-blueprint-locator]')).toHaveLength(1);
  });

  it.each(['project', 'library'] as const)('moves a nested folder with its blueprints, rejects cycles and preserves its ancestry on remount in %s', async (scopeKind) => {
    const local = plan('nested', 'Nested blueprint');
    let organization = nameBlueprintFolder(emptyBlueprintFolders(), 'project:project-1', 'delivery', 'Delivery');
    organization = nameBlueprintFolder(organization, 'project:project-1', 'mobile', 'Mobile', 'delivery');
    organization = nameBlueprintFolder(organization, 'project:project-1', 'product', 'Product');
    const { toPlanLocatorKey } = await import('../../services/durableIdentity');
    organization = moveBlueprintToFolder(organization, 'project:project-1', toPlanLocatorKey({ branchName: 'develop', planId: local.id }), 'mobile');
    await savePreference(PREF_KEYS.ARCHITECT_BLUEPRINT_FOLDERS, organization);
    useAppStore.setState({ standaloneProjects: [{ id: 'project-1', name: 'Sample project', path: '/demo/project', gitSetupState: 'ready' }] as never, projectGroups: [], selectedProjectId: 'project-1', selectedGroupId: null, activeArchitectPlanId: null, activePlanContext: null });
    const catalogLoader = mock(async (): Promise<MacroProjectMetadataLoadResult> => ({
      snapshot: { branchCatalogByBranch: {}, branches: [{ branchName: 'develop', activePlanId: null, plans: [local], error: null }], scannedBranchNames: ['develop'], scopedProjectIds: ['project-1'], visiblePlans: [local], modernPlanCount: 1, selectedPlan: null, selectedBranchName: null, selectionReason: 'none', errors: [] },
      selectedPlan: null, selectedBranchName: null, selectionReason: 'none',
    }));
    await act(async () => { root?.render(<ArchitectProjectNavigator macroBlueprintProjectId={scopeKind === 'library' ? 'project-1' : undefined} catalogLoader={catalogLoader} />); await flushRender(); });
    const folder = (id: string) => container!.querySelector<HTMLElement>(`[data-blueprint-folder="${id}"]`)!;
    expect(folder('delivery').querySelector('[data-blueprint-folder="mobile"] [data-blueprint-locator]')?.textContent).toContain('Nested blueprint');
    const values = new Map<string, string>();
    const transfer = { effectAllowed: 'none', dropEffect: 'none', setData: (key: string, value: string) => values.set(key, value), getData: (key: string) => values.get(key) ?? '' };
    const drag = (target: HTMLElement, type: string) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer }); target.dispatchEvent(event);
    };
    await act(async () => { drag(folder('delivery').querySelector<HTMLElement>('[data-blueprint-folder-header]')!, 'dragstart'); await flushRender(); });
    await act(async () => { drag(folder('mobile'), 'drop'); await flushRender(); });
    expect(folder('delivery').querySelector('[data-blueprint-folder="mobile"]')).not.toBeNull();
    expect(folder('mobile').querySelector('[data-blueprint-folder="delivery"]')).toBeNull();
    await act(async () => { drag(folder('mobile').querySelector<HTMLElement>('[data-blueprint-folder-header]')!, 'dragstart'); await flushRender(); });
    await act(async () => { drag(folder('product'), 'drop'); await flushRender(); });
    expect(folder('delivery').querySelector('[data-blueprint-folder="mobile"]')).toBeNull();
    expect(folder('product').querySelector('[data-blueprint-folder="mobile"] [data-blueprint-locator]')?.textContent).toContain('Nested blueprint');
    expect(container!.querySelectorAll('[data-blueprint-locator]')).toHaveLength(1);
    const contextMenu = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 200 });
    await act(async () => { folder('mobile').querySelector<HTMLElement>('[data-blueprint-folder-header]')!.dispatchEvent(contextMenu); await flushRender(); });
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-architect-scope-context-menu]')).toBeNull();
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.includes('New subfolder'))!.click(); await flushRender();
    });
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Reviews');
      input.dispatchEvent(new window.Event('input', { bubbles: true })); await flushRender();
    });
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'Create')!.click(); await flushRender();
    });
    const saved = await loadPreference<{ folders: { id: string; name: string; parentId?: string | null }[] }>(PREF_KEYS.ARCHITECT_BLUEPRINT_FOLDERS);
    const child = saved.folders.find(folder => folder.name === 'Reviews')!;
    expect(child.parentId).toBe('mobile');
    expect(folder('product').contains(folder(child.id))).toBe(true);
    expect(folder('mobile').contains(folder(child.id))).toBe(true);
    await act(async () => {
      folder('mobile').querySelector<HTMLElement>('[data-blueprint-locator] button')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await flushRender();
    });
    expect([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].some(button => button.textContent?.includes('New subfolder'))).toBe(false);
    await act(async () => { root?.render(<div />); await flushRender(); });
    await act(async () => { root?.render(<ArchitectProjectNavigator macroBlueprintProjectId={scopeKind === 'library' ? 'project-1' : undefined} catalogLoader={catalogLoader} />); await flushRender(); });
    expect(folder('product').querySelector('[data-blueprint-folder="mobile"] [data-blueprint-locator]')?.textContent).toContain('Nested blueprint');
    await act(async () => { drag(folder('mobile').querySelector<HTMLElement>('[data-blueprint-folder-header]')!, 'dragstart'); await flushRender(); });
    const projectHeader = container!.querySelector<HTMLElement>('[data-architect-scope-id="project:project-1"] [data-architect-scope-menu]')!;
    const enter = new window.Event('dragenter', { bubbles: true, cancelable: true });
    Object.defineProperty(enter, 'dataTransfer', { value: transfer });
    await act(async () => { projectHeader.dispatchEvent(enter); await flushRender(); });
    expect(enter.defaultPrevented).toBe(true);
    await act(async () => { drag(projectHeader, 'drop'); await flushRender(); });
    expect(folder('product').querySelector('[data-blueprint-folder="mobile"]')).toBeNull();
    expect(folder('mobile').querySelector('[data-blueprint-locator]')?.textContent).toContain('Nested blueprint');
  });

  it.each(['project', 'library'] as const)('creates independent blueprints directly inside the folder selected by right click in %s', async (scopeKind) => {
    const existing = plan('existing', 'Existing empty plan');
    let organization = nameBlueprintFolder(emptyBlueprintFolders(), 'project:project-1', 'delivery', 'Delivery');
    organization = nameBlueprintFolder(organization, 'project:project-1', 'mobile', 'Mobile', 'delivery');
    organization = moveBlueprintToFolder(organization, 'project:project-1', toPlanLocatorKey({ branchName: 'develop', planId: existing.id }), 'delivery');
    await savePreference(PREF_KEYS.ARCHITECT_BLUEPRINT_FOLDERS, organization);
    const activate = mock(async () => true);
    useAppStore.setState({ standaloneProjects: [{ id: 'project-1', name: 'Sample project', path: '/demo/project', gitSetupState: 'ready' }] as never, projectGroups: [], selectedProjectId: 'project-1', selectedGroupId: null, activeArchitectPlanId: null, activePlanContext: null, activateArchitectPlan: activate as never });
    const catalog = [existing];
    const catalogLoader = mock(async (): Promise<MacroProjectMetadataLoadResult> => ({
      snapshot: { branchCatalogByBranch: {}, branches: [{ branchName: 'develop', activePlanId: null, plans: catalog, error: null }], scannedBranchNames: ['develop'], scopedProjectIds: ['project-1'], visiblePlans: catalog, modernPlanCount: catalog.length, selectedPlan: null, selectedBranchName: null, selectionReason: 'none', errors: [] },
      selectedPlan: null, selectedBranchName: null, selectionReason: 'none',
    }));
    let nextId = 0;
    const planCreator = mock(async (input: Parameters<NonNullable<Parameters<typeof ArchitectProjectNavigator>[0]['planCreator']>>[0]) => {
      const id = `fresh-${++nextId}`;
      const record: ArchitectPlanRecord = { ...plan(id, id), label: input.label, nodes: [], predictedBranches: [], agsdl: { ...input.agsdl!, revision: 1 } };
      catalog.push({ ...record, nodeCount: 0, hasAgsdl: true });
      return record;
    });
    await act(async () => { root?.render(<ArchitectProjectNavigator macroBlueprintProjectId={scopeKind === 'library' ? 'project-1' : undefined} catalogLoader={catalogLoader} planCreator={planCreator} />); await flushRender(); });
    for (let count = 1; count <= 2; count++) {
      await act(async () => {
        container!.querySelector<HTMLElement>('[data-blueprint-folder="mobile"] [data-blueprint-folder-header]')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await flushRender();
      });
      const create = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.includes('New blueprint'))!;
      expect(create.disabled).toBe(false);
      await act(async () => { create.click(); await flushRender(); });
      expect(planCreator).toHaveBeenCalledTimes(count);
      expect(container!.querySelectorAll('[data-blueprint-folder="mobile"] [data-blueprint-locator]')).toHaveLength(count);
      expect(activate).toHaveBeenLastCalledWith(`fresh-${count}`, expect.objectContaining({ targetBranch: 'develop', scopedProjectIdsHint: ['project-1'] }));
    }
    expect(planCreator).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', projectIds: ['project-1'], planKind: 'feature', agsdl: expect.objectContaining({ source: expect.any(String) }) }));
    const saved = await loadPreference<typeof organization>(PREF_KEYS.ARCHITECT_BLUEPRINT_FOLDERS);
    expect(saved.placements[JSON.stringify(['project:project-1', toPlanLocatorKey({ branchName: 'develop', planId: existing.id })])]).toBe('delivery');
    expect(container!.querySelectorAll('[data-blueprint-locator]')).toHaveLength(3);
    await act(async () => {
      useAppStore.setState({ standaloneProjects: [{ id: 'project-1', name: 'Sample project', path: '/demo/project', gitSetupState: 'ready', isReadOnly: true }] as never }); await flushRender();
      container!.querySelector<HTMLElement>('[data-blueprint-folder="mobile"] [data-blueprint-folder-header]')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await flushRender();
    });
    const readOnlyCreate = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.includes('New blueprint'))!;
    expect(readOnlyCreate.disabled).toBe(true);
    await act(async () => { readOnlyCreate.click(); await flushRender(); });
    expect(planCreator).toHaveBeenCalledTimes(2);
  });

  it('targets right-click actions without changing selection and keeps background and text-field menus distinct', async () => {
    const local = plan('local', 'Local blueprint');
    await savePreference(PREF_KEYS.ARCHITECT_NAVIGATOR_EXPANDED_SCOPE_IDS, ['project:project-1']);
    const activate = mock(async () => true);
    useAppStore.setState({ standaloneProjects: [
      { id: 'project-1', name: 'First project', path: '/demo/first', gitSetupState: 'ready' },
      { id: 'project-2', name: 'Second project', path: '/demo/second', gitSetupState: 'ready' },
    ] as never, projectGroups: [], selectedProjectId: 'project-1', selectedGroupId: null, activeArchitectPlanId: null, activePlanContext: null, activateArchitectPlan: activate as never });
    const catalogLoader = mock(async (): Promise<MacroProjectMetadataLoadResult> => ({
      snapshot: { branchCatalogByBranch: {}, branches: [{ branchName: 'develop', activePlanId: null, plans: [local], error: null }], scannedBranchNames: ['develop'], scopedProjectIds: ['project-1', 'project-2'], visiblePlans: [local], modernPlanCount: 1, selectedPlan: null, selectedBranchName: null, selectionReason: 'none', errors: [] },
      selectedPlan: null, selectedBranchName: null, selectionReason: 'none',
    }));
    await act(async () => { root?.render(<ArchitectProjectNavigator catalogLoader={catalogLoader} />); await flushRender(); });
    const rightClick = async (target: HTMLElement) => {
      const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 170 });
      await act(async () => { target.dispatchEvent(event); await flushRender(); });
      return event;
    };
    const second = container!.querySelector<HTMLElement>('[data-architect-scope-id="project:project-2"]')!;
    await rightClick(second);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('New blueprint');
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('New folder');
    expect(useAppStore.getState().selectedProjectId).toBe('project-1');
    const localButton = [...container!.querySelectorAll('button')].find(item => item.textContent?.includes('Local blueprint'))!;
    await rightClick(localButton);
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Move to');
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('New folder');
    expect(activate).not.toHaveBeenCalled();
    await rightClick(container!.querySelector('aside')!);
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Ajouter un projet');
    await act(async () => { container!.querySelector<HTMLButtonElement>('[data-tour-id="architect-search-toggle"]')!.click(); await flushRender(); });
    const input = container!.querySelector<HTMLInputElement>('input')!;
    expect((await rightClick(input)).defaultPrevented).toBe(false);
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
    expect(menu?.querySelector('button')?.textContent).toContain('Create a system');
    expect(menu?.querySelector('button')?.textContent).toContain('Start from scratch or use a blueprint.');
    const secondary = menu?.querySelector('details');
    expect(secondary?.open).toBe(false);
    expect(secondary?.querySelector('summary')?.textContent).toContain('Other plan types');
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

  it('keeps every scope collapsed when the expanded-scope preference is empty', async () => {
    await savePreference(PREF_KEYS.ARCHITECT_NAVIGATOR_EXPANDED_SCOPE_IDS, []);
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
    const catalogLoader = mock(async (): Promise<MacroProjectMetadataLoadResult> => ({
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
    }));

    await act(async () => {
      root?.render(<ArchitectProjectNavigator catalogLoader={catalogLoader} />);
      await flushRender();
    });

    const scope = document.body.querySelector<HTMLElement>('[data-architect-scope-id="project:project-1"]');
    expect(scope?.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    expect(scope?.textContent).not.toContain('Plan existant');
  });

  it('reports a rejected preference read without discarding loaded pins', async () => {
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
    const catalogLoader = mock(async (): Promise<MacroProjectMetadataLoadResult> => ({
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
    }));
    const preferenceLoader = {
      loadPinnedPlanIds: mock(async () => ['existing-plan']),
      loadExpandedScopeIds: mock(async () => {
        throw new Error('preference read failed');
      }),
    };

    await act(async () => {
      root?.render(
        <ArchitectProjectNavigator
          catalogLoader={catalogLoader}
          preferenceLoader={preferenceLoader}
        />
      );
      await flushRender();
    });

    expect(document.body.textContent).toContain('Impossible de charger les préférences du navigateur.');
    expect(document.body.querySelector('[aria-labelledby="architect-pinned-plans-title"]')?.textContent)
      .toContain('Plan existant');
    const scope = document.body.querySelector<HTMLElement>('[data-architect-scope-id="project:project-1"]');
    expect(scope?.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  });
});
