import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useAgsdlTranslation } from '../agsdl/useAgsdlTranslation';
import { ensureScopedBlankPlan } from '../../services/architectAutoPlan';
import {
  createArchitectPlan,
  getArchitectPlan,
  getArchitectPlanCrudCapabilities,
  getGitFlowBaseBranch,
  updateArchitectPlan,
  type ArchitectPlanRecord,
} from '../../services/architectPlanService';
import {
  archivePlanAndCleanupBranches,
  deletePlanAndCleanupBranches,
  restorePlanAndProvisionBranches,
} from '../../services/architectGitFlowService';
import {
  getArchitectPlanKind,
  getCreatableArchitectPlanKinds,
  type ArchitectPlanKind,
} from '../../services/architectPlanKinds';
import {
  getArchitectPlanDisplayName,
  getArchitectPlanEditableName,
  getArchitectPlanPrimaryName,
  getNextDefaultNewPlanLabel,
  isCanonicalArchitectPlan,
} from '../../services/architectPlanPresentation';
import { isProjectPlanActionable } from '../../services/globalProjects';
import { loadMacroProjectMetadataForSelection } from '../../services/macroProjectMetadataLoader';
import {
  loadPersistedPreference,
  loadPreference,
  PREF_KEYS,
  savePreference,
} from '../../services/preferences';
import { getPlanKindIconName } from '../../services/planKindPresentation';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { useViewFilterStore } from '../../stores/useViewFilterStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { ProjectIcon } from '../project/ProjectIcon';
import { PanelHeaderIconButton } from '../ui/PanelHeaderIconButton';
import { SearchBar } from '../ui/SearchBar';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { notify } from '../ui/toastService';
import { PlanIconDialog } from './PlanIconDialog';
import { getPlanIcon, type PlanIcon } from '../../services/planIcon';
import { PlanFormModal } from './PlanFormModal';
import {
  registerArchitectPlanSelectorRequestHandler,
  registerArchitectPlanSelectorStatePublisher,
  type ArchitectPlanSelectorRequestDetail,
  type ArchitectPlanSelectorStateDetail,
} from './planSelectorEvents';
import {
  buildArchitectNavigatorPlanEntries,
  buildArchitectNavigatorScopes,
  filterArchitectPlanEntriesByQuery,
  sanitizeArchitectNavigatorIds,
  toggleArchitectNavigatorScope,
  type ArchitectNavigatorPlanEntry,
  type ArchitectNavigatorScope,
} from './architectProjectNavigatorModel';
import {
  getAnchoredArchitectMenuPosition,
  getPointerArchitectMenuPosition,
  type ArchitectMenuAnchorRect,
  type ArchitectMenuPosition,
} from './architectProjectNavigatorMenu';

import { createEmptySystemDocument } from '../../services/agsdl/design';
import { toPlanLocatorKey } from '../../services/durableIdentity';
import { useBlueprintFolders } from '../../hooks/useBlueprintFolders';
import { blueprintFolderId, blueprintFolderAncestors, blueprintFolderTree, canMoveBlueprintFolder, moveBlueprintFolder, moveBlueprintToFolder, nameBlueprintFolder, type BlueprintFolder, type BlueprintNavigatorDrag } from '../../services/blueprintFolders';
import { BlueprintFolderTree, BLUEPRINT_DRAG_TYPE } from './BlueprintFolderTree';

type NavigatorSection = 'macro' | 'projects';
const NAVIGATOR_SECTION_IDS = new Set(['macro', 'projects']);
const MAX_VISIBLE_PLANS_PER_SCOPE = 7;
const SCOPE_CREATE_MENU_WIDTH = 240;
const SCOPE_CONTEXT_MENU_WIDTH = 208;

interface ScopeCreateMenuState {
  scopeId: string;
  triggerKey: 'header' | 'empty' | 'external';
  anchorRect: ArchitectMenuAnchorRect;
}

interface ScopeContextMenuState {
  scopeId: string;
  position: ArchitectMenuPosition;
}

const summarizePlanRecord = (plan: ArchitectPlanRecord) => ({
  ...plan,
  nodeCount: plan.nodes.length,
  predictedBranchCount: plan.predictedBranches.length,
});

const scopeIsSelected = (
  scope: ArchitectNavigatorScope,
  selectedGroupId: string | null,
  selectedProjectId: string | null,
): boolean =>
  scope.kind === 'group'
    ? scope.groupId === selectedGroupId
    : !selectedGroupId && scope.projectId === selectedProjectId;

interface ArchitectProjectNavigatorProps {
  macroBlueprintProjectId?: string;
  catalogLoader?: typeof loadMacroProjectMetadataForSelection;
  planCreator?: typeof createArchitectPlan;
  preferenceLoader?: {
    loadPinnedPlanIds: () => Promise<unknown>;
    loadExpandedScopeIds: () => Promise<unknown>;
    loadCollapsedSections?: () => Promise<unknown>;
  };
}

const defaultPreferenceLoader: NonNullable<ArchitectProjectNavigatorProps['preferenceLoader']> = {
  loadCollapsedSections: () => loadPreference<unknown>(PREF_KEYS.ARCHITECT_NAVIGATOR_COLLAPSED_SECTIONS),
  loadPinnedPlanIds: () => loadPreference<unknown>(PREF_KEYS.ARCHITECT_PINNED_PLAN_IDS),
  loadExpandedScopeIds: () => loadPersistedPreference<unknown>(PREF_KEYS.ARCHITECT_NAVIGATOR_EXPANDED_SCOPE_IDS),
};

export const ArchitectProjectNavigator: React.FC<ArchitectProjectNavigatorProps> = ({
  macroBlueprintProjectId,
  catalogLoader = loadMacroProjectMetadataForSelection,
  planCreator = createArchitectPlan,
  preferenceLoader = defaultPreferenceLoader,
}) => {
  const { t } = useTranslation();
  const { t: agsdlT } = useAgsdlTranslation();
  const standaloneProjects = useAppStore((state) => state.standaloneProjects);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const activeArchitectPlanId = useAppStore((state) => state.activeArchitectPlanId);
  const activePlanContext = useAppStore((state) => state.activePlanContext);
  const architectPlanSwitch = useAppStore((state) => state.architectPlanSwitch);
  const isProjectSwitching = useAppStore((state) => state.isProjectSwitching);
  const setSelectedGroup = useAppStore((state) => state.setSelectedGroup);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const setLeftPanelOpen = useAppStore((state) => state.setLeftPanelOpen);
  const activateArchitectPlan = useAppStore((state) => state.activateArchitectPlan);
  const refreshCurrentPlanCatalog = useAppStore((state) => state.loadMacroProjectMetadataForSelection);
  const openProjectNavigator = useAppStore((state) => state.openProjectNavigator);
  const openProjectModal = useAppStore((state) => state.openProjectModal);
  const renameProject = useAppStore((state) => state.renameProject);
  const renameProjectGroup = useAppStore((state) => state.renameProjectGroup);

  const folders = useBlueprintFolders(() => notify.error(t('architect.projectNavigator.folderSaveError', 'Could not save folder organization.')));
  const [folderForm, setFolderForm] = useState<{ scopeId: string; folder?: BlueprintFolder; parentId?: string | null } | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [blueprintToMove, setBlueprintToMove] = useState<ArchitectNavigatorPlanEntry | null>(null);
  const [folderToMove, setFolderToMove] = useState<BlueprintFolder | null>(null);
  const [draggedItem, setDraggedItem] = useState<BlueprintNavigatorDrag | null>(null);
  const [rootDropScopeId, setRootDropScopeId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ArchitectNavigatorPlanEntry[]>([]);
  const [collapsedSections, setCollapsedSections] = useState<string[]>([]);
  const [expandedScopeIds, setExpandedScopeIds] = useState<string[]>([]);
  const [pinnedPlanIds, setPinnedPlanIds] = useState<string[]>([]);
  const [expandedPlanLists, setExpandedPlanLists] = useState<string[]>([]);
  const showArchived = useViewFilterStore((state) => state.architect.showArchived);
  const setArchitectShowArchived = useViewFilterStore(
    (state) => state.setArchitectShowArchived,
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [creatingScopeId, setCreatingScopeId] = useState<string | null>(null);
  const [creatingPlanKind, setCreatingPlanKind] = useState<ArchitectPlanKind | null>(null);
  const [activatingPlanId, setActivatingPlanId] = useState<string | null>(null);
  const [openPlanMenuKey, setOpenPlanMenuKey] = useState<string | null>(null);
  const [scopeCreateMenu, setScopeCreateMenu] = useState<ScopeCreateMenuState | null>(null);
  const [scopeContextMenu, setScopeContextMenu] = useState<ScopeContextMenuState | null>(null);
  const [scopeToRename, setScopeToRename] = useState<ArchitectNavigatorScope | null>(null);
  const [isRenamingScope, setIsRenamingScope] = useState(false);
  const [planToEdit, setPlanToEdit] = useState<ArchitectNavigatorPlanEntry | null>(null);
  const [planToChooseIcon, setPlanToChooseIcon] = useState<ArchitectNavigatorPlanEntry | null>(null);
  const [planToDelete, setPlanToDelete] = useState<ArchitectNavigatorPlanEntry | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [mutatingPlanId, setMutatingPlanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const expandedScopesInteractionRef = useRef(false);
  const sectionsInteractionRef = useRef(false);
  const collapsedSectionsRef = useRef<string[]>([]);
  const pendingPrimaryRequestRef = useRef<ArchitectPlanSelectorRequestDetail | null>(null);
  const scopeCreateButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const scopes = useMemo(
    () => buildArchitectNavigatorScopes({ standaloneProjects, projectGroups }),
    [projectGroups, standaloneProjects],
  );
  const scopesById = useMemo(
    () => new Map(scopes.map((scope) => [scope.id, scope])),
    [scopes],
  );
  const allProjectIds = useMemo(
    () => Array.from(new Set(scopes.flatMap((scope) => scope.projectIds))),
    [scopes],
  );
  const activeEntries = useMemo(
    () => entries.filter((entry) => entry.plan.status !== 'archived'),
    [entries],
  );
  const archivedEntries = useMemo(
    () => entries.filter((entry) => entry.plan.status === 'archived'),
    [entries],
  );
  const hasSearchQuery = searchQuery.trim().length > 0;
  const searchedActiveEntries = useMemo(
    () => filterArchitectPlanEntriesByQuery(activeEntries, searchQuery),
    [activeEntries, searchQuery],
  );
  const searchedArchivedEntries = useMemo(
    () => filterArchitectPlanEntriesByQuery(archivedEntries, searchQuery),
    [archivedEntries, searchQuery],
  );
  const catalogEntriesByScope = useMemo(() => {
    const result = new Map<string, ArchitectNavigatorPlanEntry[]>();
    for (const entry of activeEntries) {
      const current = result.get(entry.scopeId) ?? [];
      current.push(entry);
      result.set(entry.scopeId, current);
    }
    return result;
  }, [activeEntries]);
  const entriesByScope = useMemo(() => {
    const result = new Map<string, ArchitectNavigatorPlanEntry[]>();
    for (const entry of searchedActiveEntries) {
      const current = result.get(entry.scopeId) ?? [];
      current.push(entry);
      result.set(entry.scopeId, current);
    }
    return result;
  }, [searchedActiveEntries]);
  const macroScope = useMemo(() => scopes.find(scope => scope.projectId === macroBlueprintProjectId), [scopes, macroBlueprintProjectId]);
  const projectScopes = useMemo(() => scopes.filter(scope => scope !== macroScope), [scopes, macroScope]);
  const macroEntries = macroScope ? entriesByScope.get(macroScope.id) ?? [] : [];
  const displayedScopes = useMemo(
    () => hasSearchQuery
      ? projectScopes.filter((scope) => (entriesByScope.get(scope.id)?.length ?? 0) > 0)
      : projectScopes,
    [entriesByScope, hasSearchQuery, projectScopes],
  );
  const pinnedEntries = useMemo(() => {
    const pinned = new Set(pinnedPlanIds);
    const countsByPlanId = new Map<string, number>();
    activeEntries.forEach((entry) => countsByPlanId.set(
      entry.plan.id,
      (countsByPlanId.get(entry.plan.id) || 0) + 1,
    ));
    return activeEntries.filter((entry) =>
      pinned.has(entry.locatorKey) ||
      (countsByPlanId.get(entry.plan.id) === 1 && pinned.has(entry.plan.id))
    );
  }, [activeEntries, pinnedPlanIds]);
  const selectedScope = useMemo(
    () => scopes.find((scope) => scopeIsSelected(scope, selectedGroupId, selectedProjectId)) ?? null,
    [scopes, selectedGroupId, selectedProjectId],
  );
  const isBusy = isProjectSwitching || architectPlanSwitch.status === 'resolving';
  const activeTargetBranch = activePlanContext?.targetBranch ?? null;
  const planKindLabel = useCallback((planKind: ArchitectPlanKind): string => {
    switch (planKind) {
      case 'release':
        return t('architect.planSelector.kindRelease', 'Release');
      case 'hotfix':
        return t('architect.planSelector.kindHotfix', 'Hotfix');
      case 'bugfix':
        return t('architect.planSelector.kindBugfix', 'Bugfix');
      default:
        return t('architect.planSelector.kindFeature', 'Feature');
    }
  }, [t]);
  const planKindHelp = useCallback((planKind: ArchitectPlanKind): string => {
    switch (planKind) {
      case 'release':
        return t('architect.planSelector.kindReleaseHelp', 'Stabiliser et livrer.');
      case 'hotfix':
        return t('architect.planSelector.kindHotfixHelp', 'Corriger rapidement la production.');
      case 'bugfix':
        return t('architect.planSelector.kindBugfixHelp', 'Corriger un bug normal.');
      default:
        return t('architect.planSelector.kindFeatureHelp', 'Construire quelque chose de nouveau.');
    }
  }, [t]);

  const refreshPlans = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (allProjectIds.length === 0) {
      setEntries([]);
      setIsLoading(false);
      setError(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await catalogLoader({
        scopedProjectIds: allProjectIds,
        currentActivePlanId: activeArchitectPlanId,
        currentTargetBranch: activeTargetBranch,
        includeArchivedInVisible: true,
      });
      if (requestId !== requestIdRef.current) return;
      setEntries(buildArchitectNavigatorPlanEntries({
        branches: result.snapshot.branches,
        scopes,
      }));
      if (result.snapshot.errors.length > 0) {
        setError(t('architect.projectNavigator.loadError', 'Impossible de charger les plans.'));
      }
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      const message = loadError instanceof Error
        ? loadError.message
        : t('architect.projectNavigator.loadError', 'Impossible de charger les plans.');
      setError(message);
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [activeArchitectPlanId, activeTargetBranch, allProjectIds, catalogLoader, scopes, t]);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      preferenceLoader.loadPinnedPlanIds(),
      preferenceLoader.loadExpandedScopeIds(),
      preferenceLoader.loadCollapsedSections?.() ?? Promise.resolve([]),
    ]).then(([pinnedResult, expandedResult, sectionsResult]) => {
      if (cancelled) return;
      const validScopeIds = new Set(scopes.map((scope) => scope.id));
      let didFail = false;
      if (pinnedResult.status === 'fulfilled') {
        setPinnedPlanIds(sanitizeArchitectNavigatorIds(pinnedResult.value));
      } else {
        didFail = true;
      }

      if (expandedResult.status === 'fulfilled') {
        if (!expandedScopesInteractionRef.current) {
          const persistedScopes = expandedResult.value;
          const sanitizedScopes = sanitizeArchitectNavigatorIds(persistedScopes, validScopeIds);
          setExpandedScopeIds(
            persistedScopes !== undefined
              ? sanitizedScopes
              : scopes.length <= 3
                ? scopes.map((scope) => scope.id)
                : selectedScope
                  ? [selectedScope.id]
                  : scopes[0]
                    ? [scopes[0].id]
                    : [],
          );
        }
      } else {
        didFail = true;
      }

      if (sectionsResult.status === 'fulfilled') {
        if (!sectionsInteractionRef.current) {
          const sections = sanitizeArchitectNavigatorIds(sectionsResult.value, NAVIGATOR_SECTION_IDS);
          collapsedSectionsRef.current = sections;
          setCollapsedSections(sections);
        }
      } else {
        didFail = true;
      }

      if (didFail) {
        setError(t('architect.projectNavigator.preferenceLoadError', 'Impossible de charger les préférences du navigateur.'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [preferenceLoader, scopes, selectedScope, t]);

  useEffect(() => {
    void refreshPlans();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refreshPlans]);

  useEffect(() => {
    const selectedPlans = selectedScope ? catalogEntriesByScope.get(selectedScope.id) ?? [] : [];
    const detail: ArchitectPlanSelectorStateDetail = {
      status: error ? 'error' : isLoading ? 'loading' : 'ready',
      planCount: selectedPlans.length,
      canCreate: Boolean(selectedScope?.projects.some(isProjectPlanActionable)),
      canSelect: selectedPlans.length > 0,
    };
    return registerArchitectPlanSelectorStatePublisher(detail);
  }, [catalogEntriesByScope, error, isLoading, selectedScope]);

  const persistExpandedScopes = useCallback((next: string[]) => {
    expandedScopesInteractionRef.current = true;
    setExpandedScopeIds(next);
    void savePreference(PREF_KEYS.ARCHITECT_NAVIGATOR_EXPANDED_SCOPE_IDS, next);
  }, []);

  const setSectionExpanded = useCallback((section: NavigatorSection, expanded: boolean) => {
    sectionsInteractionRef.current = true;
    setOpenPlanMenuKey(null);
    setScopeCreateMenu(null);
    setScopeContextMenu(null);
    const current = collapsedSectionsRef.current;
    const next = expanded
      ? current.filter((id) => id !== section)
      : [...new Set([...current, section])];
    collapsedSectionsRef.current = next;
    setCollapsedSections(next);
    void savePreference(PREF_KEYS.ARCHITECT_NAVIGATOR_COLLAPSED_SECTIONS, next);
  }, []);
  const macroExpanded = hasSearchQuery || !collapsedSections.includes('macro');
  const projectsExpanded = hasSearchQuery || !collapsedSections.includes('projects');

  const toggleScope = (scopeId: string) => {
    setScopeCreateMenu(null);
    setScopeContextMenu(null);
    persistExpandedScopes(toggleArchitectNavigatorScope(expandedScopeIds, scopeId));
  };

  const applyScopeSelection = useCallback((scope: ArchitectNavigatorScope) => {
    if (scope.kind === 'group') {
      setSelectedGroup(scope.groupId);
    } else {
      setSelectedProject(scope.projectId);
    }
  }, [setSelectedGroup, setSelectedProject]);

  const selectScope = useCallback((scope: ArchitectNavigatorScope) => {
    applyScopeSelection(scope);
    if (!expandedScopeIds.includes(scope.id)) {
      persistExpandedScopes([...expandedScopeIds, scope.id]);
    }
  }, [applyScopeSelection, expandedScopeIds, persistExpandedScopes]);

  const selectAndToggleScope = useCallback((scope: ArchitectNavigatorScope) => {
    setOpenPlanMenuKey(null);
    setScopeCreateMenu(null);
    setScopeContextMenu(null);
    applyScopeSelection(scope);
    persistExpandedScopes(toggleArchitectNavigatorScope(expandedScopeIds, scope.id));
  }, [applyScopeSelection, expandedScopeIds, persistExpandedScopes]);

  const openScopeCreateMenu = useCallback((
    scopeId: string,
    triggerKey: ScopeCreateMenuState['triggerKey'],
    anchorRect: ArchitectMenuAnchorRect,
  ) => {
    setOpenPlanMenuKey(null);
    setScopeContextMenu(null);
    setScopeCreateMenu((current) =>
      current?.scopeId === scopeId && current.triggerKey === triggerKey
        ? null
        : { scopeId, triggerKey, anchorRect }
    );
  }, []);

  const togglePin = (planId: string) => {
    const next = pinnedPlanIds.includes(planId)
      ? pinnedPlanIds.filter((id) => id !== planId)
      : [...pinnedPlanIds, planId];
    setPinnedPlanIds(next);
    void savePreference(PREF_KEYS.ARCHITECT_PINNED_PLAN_IDS, next);
  };

  const activatePlan = async (entry: ArchitectNavigatorPlanEntry) => {
    if (isBusy) return;
    setActivatingPlanId(entry.locatorKey);
    setError(null);
    try {
      const scope = scopesById.get(entry.scopeId);
      const activated = await activateArchitectPlan(entry.plan.id, {
        targetBranch: entry.branchName,
        planSummaryHint: entry.plan,
        scopedProjectIdsHint: scope?.projectIds ?? [],
        persistActiveSelection: entry.plan.status !== 'archived',
      });
      if (!activated) throw new Error(t('architect.projectNavigator.activateError', 'Ce plan n’est plus disponible.'));
    } catch (activationError) {
      const message = activationError instanceof Error
        ? activationError.message
        : t('architect.projectNavigator.activateError', 'Ce plan n’est plus disponible.');
      setError(message);
      notify.error(message);
    } finally {
      setActivatingPlanId(null);
    }
  };

  const refreshAfterMutation = async () => {
    await refreshCurrentPlanCatalog({
      hydrateActivePlan: true,
      refreshTasks: true,
      includeArchivedInVisible: false,
      preserveCurrentActivePlan: true,
      reason: 'manual',
    });
    await refreshPlans();
  };

  const editPlan = async (value: string) => {
    if (!planToEdit) return;
    setFormLoading(true);
    setFormError(null);
    try {
      const current = await getArchitectPlan(planToEdit.branchName, planToEdit.plan.id);
      if (!current || !getArchitectPlanCrudCapabilities(current).canEditDetails) {
        throw new Error(t('architect.projectNavigator.editUnavailable', 'Ce plan ne peut plus être modifié.'));
      }
      const updated = await updateArchitectPlan({
        branchName: planToEdit.branchName,
        planId: planToEdit.plan.id,
        ...(isCanonicalArchitectPlan(current) ? { label: value } : { title: value }),
      });
      if (updated.conversationId) {
        await useChatStore.getState().syncArchitectPlanConversationMetadata(updated.conversationId, updated);
      }
      setPlanToEdit(null);
      await refreshAfterMutation();
    } catch (editError) {
      setFormError(editError instanceof Error
        ? editError.message
        : t('architect.projectNavigator.editError', 'Impossible de modifier le plan.'));
    } finally {
      setFormLoading(false);
    }
  };

  const choosePlanIcon = async (icon: PlanIcon | null) => {
    if (!planToChooseIcon || formLoading) return;
    setFormLoading(true);
    setFormError(null);
    try {
      const current = await getArchitectPlan(planToChooseIcon.branchName, planToChooseIcon.plan.id);
      if (!current || !getArchitectPlanCrudCapabilities(current).canEditDetails) {
        throw new Error(t('architect.projectNavigator.editUnavailable', 'Ce plan ne peut plus être modifié.'));
      }
      await updateArchitectPlan({ branchName: planToChooseIcon.branchName, planId: current.id, expectedRevision: current.revision, icon });
      await refreshAfterMutation();
      setPlanToChooseIcon(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t('architect.projectNavigator.editError', 'Impossible de modifier le plan.'));
    } finally {
      setFormLoading(false);
    }
  };

  const archivePlan = async (entry: ArchitectNavigatorPlanEntry) => {
    if (mutatingPlanId) return;
    setOpenPlanMenuKey(null);
    setMutatingPlanId(entry.locatorKey);
    let releaseMutation: (() => void) | null = null;
    try {
      if (entry.plan.status === 'archived') {
        await restorePlanAndProvisionBranches({ branchName: entry.branchName, planId: entry.plan.id });
        notify.success(t('architect.projectNavigator.planRestored', 'Plan restauré.'));
      } else {
        const taskStore = useTaskStore.getState();
        if (!taskStore.reservePlanWorktreeMutation(entry.plan.id)) {
          throw new Error(t('implement.taskCommandsPlanMutationActive', 'Arrêtez les commandes actives avant d’archiver ce plan.'));
        }
        releaseMutation = () => taskStore.releasePlanWorktreeMutation(entry.plan.id);
        const latest = await getArchitectPlan(entry.branchName, entry.plan.id);
        if (!latest || !getArchitectPlanCrudCapabilities(latest).canArchive) {
          throw new Error(t('architect.projectNavigator.archiveUnavailable', 'Ce plan ne peut plus être archivé.'));
        }
        const { cleanup } = await archivePlanAndCleanupBranches({
          branchName: entry.branchName,
          planId: entry.plan.id,
        });
        taskStore.clearPlanRuntimeState({
          planId: entry.plan.id,
          branchName: entry.branchName,
          deletedWorktreeKeys: cleanup.flatMap((repository) =>
            repository.deletedWorktrees.map((worktree) => worktree.worktreeKey)),
        });
        notify.success(t('architect.projectNavigator.planArchived', 'Plan archivé.'));
      }
      await refreshAfterMutation();
    } catch (mutationError) {
      const message = mutationError instanceof Error
        ? mutationError.message
        : t('architect.projectNavigator.mutationError', 'Impossible de modifier le plan.');
      setError(message);
      notify.error(message);
    } finally {
      releaseMutation?.();
      setMutatingPlanId(null);
    }
  };

  const deletePlan = async () => {
    if (!planToDelete || isDeleting) return;
    setIsDeleting(true);
    let releaseMutation: (() => void) | null = null;
    try {
      const taskStore = useTaskStore.getState();
      if (!taskStore.reservePlanWorktreeMutation(planToDelete.plan.id)) {
        throw new Error(t('implement.taskCommandsPlanMutationActive', 'Arrêtez les commandes actives avant de supprimer ce plan.'));
      }
      releaseMutation = () => taskStore.releasePlanWorktreeMutation(planToDelete.plan.id);
      const cleanup = await deletePlanAndCleanupBranches({
        branchName: planToDelete.branchName,
        planId: planToDelete.plan.id,
      });
      taskStore.clearPlanRuntimeState({
        planId: planToDelete.plan.id,
        branchName: planToDelete.branchName,
        deletedWorktreeKeys: cleanup.deletedWorktreeKeys,
      });
      setPlanToDelete(null);
      await refreshAfterMutation();
      notify.success(t('architect.projectNavigator.planDeleted', 'Plan supprimé.'));
    } catch (deletionError) {
      const message = deletionError instanceof Error
        ? deletionError.message
        : t('architect.projectNavigator.deleteError', 'Impossible de supprimer le plan.');
      setError(message);
      notify.error(message);
    } finally {
      releaseMutation?.();
      setIsDeleting(false);
    }
  };

  const createPlan = useCallback(async (
    scope: ArchitectNavigatorScope,
    planKind: ArchitectPlanKind,
    folderId?: string,
  ) => {
    if (creatingScopeId || isBusy || isLoading || error) return;
    if (folderId && (!folders.ready || folders.busy || !folders.organization.folders.some(folder => folder.id === folderId && folder.scopeId === scope.id))) return;
    const editableProjectIds = scope.projects.filter(isProjectPlanActionable).map((project) => project.id);
    const contextProjectIds = scope.projectIds.filter((projectId) => !editableProjectIds.includes(projectId));
    if (editableProjectIds.length === 0) {
      notify.warning(t('architect.projectNavigator.readOnlyScope', 'Ce projet est en lecture seule.'));
      return;
    }
    setScopeCreateMenu(null);
    setCreatingScopeId(scope.id);
    setCreatingPlanKind(planKind);
    setError(null);
    try {
      setSectionExpanded(macroBlueprintProjectId && scope.projectId === macroBlueprintProjectId ? 'macro' : 'projects', true);
      selectScope(scope);
      const label = getNextDefaultNewPlanLabel(entries.filter(entry => entry.scopeId === scope.id).map(entry => entry.plan));
      // Explicit folder creation must not reuse or move another folder's empty draft.
      const result = folderId ? { plan: await planCreator({
        branchName: getGitFlowBaseBranch(), label, planKind,
        projectId: editableProjectIds[0], projectIds: editableProjectIds, contextProjectIds,
        agsdl: createEmptySystemDocument(t('architect.projectNavigator.newBlueprint', 'New blueprint')), status: 'draft', setActive: true,
      }) } : await ensureScopedBlankPlan({
        branchName: getGitFlowBaseBranch(),
        scopedProjectIds: editableProjectIds,
        contextProjectIds,
        planKind,
        trigger: 'explicit_create',
      });
      if (!result) throw new Error(t('architect.projectNavigator.createError', 'Impossible de créer le plan.'));
      const folderPlaced = !folderId || await folders.update(
        moveBlueprintToFolder(folders.organization, scope.id, toPlanLocatorKey({ branchName: result.plan.targetBranch, planId: result.plan.id }), folderId),
        () => notify.warning(t('architect.projectNavigator.blueprintCreatedAtRoot', 'Blueprint created at the project root. Its folder placement could not be saved.')),
      );
      const activated = await activateArchitectPlan(result.plan.id, {
        targetBranch: result.plan.targetBranch,
        planSummaryHint: summarizePlanRecord(result.plan),
        scopedProjectIdsHint: scope.projectIds,
      });
      if (!activated) throw new Error(t('architect.projectNavigator.createError', 'Impossible de créer le plan.'));
      await refreshPlans();
      if (folderPlaced) notify.success(t('architect.projectNavigator.planReady', 'Nouveau plan prêt.'));
    } catch (creationError) {
      const message = creationError instanceof Error
        ? creationError.message
        : t('architect.projectNavigator.createError', 'Impossible de créer le plan.');
      setError(message);
      notify.error(message);
    } finally {
      setCreatingScopeId(null);
      setCreatingPlanKind(null);
    }
  }, [activateArchitectPlan, creatingScopeId, entries, error, folders, isBusy, isLoading, macroBlueprintProjectId, planCreator, refreshPlans, selectScope, setSectionExpanded, t]);

  const confirmScopeRename = useCallback(async (value: string) => {
    if (!scopeToRename || isRenamingScope) return;
    const nextName = value.trim();
    if (!nextName || nextName === scopeToRename.label) {
      setScopeToRename(null);
      return;
    }

    setIsRenamingScope(true);
    try {
      if (scopeToRename.kind === 'group' && scopeToRename.groupId) {
        await renameProjectGroup(scopeToRename.groupId, nextName);
        notify.success(t('projects.groupRenamed', 'Groupe renommé.'));
      } else if (scopeToRename.projectId) {
        await renameProject(scopeToRename.projectId, nextName);
        notify.success(t('projects.projectRenamed', 'Projet renommé.'));
      }
      setScopeToRename(null);
    } catch (renameError) {
      const message = renameError instanceof Error
        ? renameError.message
        : t('common.error', 'Une erreur est survenue.');
      notify.error(message);
    } finally {
      setIsRenamingScope(false);
    }
  }, [isRenamingScope, renameProject, renameProjectGroup, scopeToRename, t]);

  useEffect(() => {
    const handleRequest = (detail: ArchitectPlanSelectorRequestDetail) => {
      if (detail?.action !== 'primary') return;
      if (isLoading) {
        pendingPrimaryRequestRef.current = detail;
        return;
      }
      pendingPrimaryRequestRef.current = null;
      if (error) return;
      if (selectedScope) {
        if (!expandedScopeIds.includes(selectedScope.id)) {
          persistExpandedScopes([...expandedScopeIds, selectedScope.id]);
        }
        const selectedPlans = catalogEntriesByScope.get(selectedScope.id) ?? [];
        if (selectedPlans.length === 0) {
          setLeftPanelOpen(true);
          if (!selectedScope.projects.some(isProjectPlanActionable)) {
            openProjectNavigator();
            return;
          }
          const anchorRect = detail.anchorRect
            ?? scopeCreateButtonRefs.current.get(selectedScope.id)?.getBoundingClientRect();
          if (anchorRect) {
            openScopeCreateMenu(selectedScope.id, 'external', anchorRect);
          }
        }
      } else {
        openProjectNavigator();
      }
    };
    const unregister = registerArchitectPlanSelectorRequestHandler(handleRequest);
    const pendingRequest = pendingPrimaryRequestRef.current;
    if (!isLoading && pendingRequest) {
      pendingPrimaryRequestRef.current = null;
      handleRequest(pendingRequest);
    }
    return unregister;
  }, [catalogEntriesByScope, error, expandedScopeIds, isLoading, openProjectNavigator, openScopeCreateMenu, persistExpandedScopes, selectedScope, setLeftPanelOpen]);

  useEffect(() => {
    if (!openPlanMenuKey && !scopeCreateMenu && !scopeContextMenu) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Element
        && event.target.closest('[data-architect-plan-menu], [data-architect-scope-menu]')
      ) return;
      setOpenPlanMenuKey(null);
      setScopeCreateMenu(null);
      setScopeContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenPlanMenuKey(null);
        setScopeCreateMenu(null);
        setScopeContextMenu(null);
      }
    };
    const closeOnViewportChange = () => {
      setScopeCreateMenu(null);
      setScopeContextMenu(null);
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [openPlanMenuKey, scopeContextMenu, scopeCreateMenu]);

  const openFolderForm = (scopeId: string, folder?: BlueprintFolder, parentId?: string | null) => {
    setScopeCreateMenu(null);
    setScopeContextMenu(null);
    setFolderError(null);
    setFolderForm({ scopeId, folder, parentId });
  };
  const confirmFolder = async (name: string) => {
    if (!folderForm) return;
    try {
      const next = nameBlueprintFolder(folders.organization, folderForm.scopeId, folderForm.folder?.id ?? crypto.randomUUID(), name, folderForm.parentId);
      if (await folders.update(next)) {
        persistExpandedScopes([...new Set([...expandedScopeIds, folderForm.scopeId])]);
        setFolderForm(null);
      }
    } catch {
      setFolderError(t('architect.projectNavigator.folderNameError', 'Choose a different folder name.'));
    }
  };
  const dropBlueprint = (scopeId: string, folderId: string | null, event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setRootDropScopeId(null);
    if (isBusy || !folders.ready || folders.busy || draggedItem?.scopeId !== scopeId) return;
    try {
      const payload = JSON.parse(event.dataTransfer.getData(BLUEPRINT_DRAG_TYPE));
      if (payload.scopeId !== scopeId || payload.kind !== draggedItem.kind) return;
      if (draggedItem.kind === 'folder') {
        const folder = folders.organization.folders.find(folder => folder.id === payload.folderId && folder.scopeId === scopeId);
        if (!folder || folder.id !== draggedItem.folderId || !canMoveBlueprintFolder(folders.organization, folder.id, folderId)) return;
        void folders.update(moveBlueprintFolder(folders.organization, folder.id, folderId));
      } else {
        const entry = entries.find(entry => entry.scopeId === scopeId && entry.locatorKey === payload.locatorKey && entry.plan.status !== 'archived');
        if (!entry || entry.locatorKey !== draggedItem.locatorKey) return;
        void folders.update(moveBlueprintToFolder(folders.organization, scopeId, entry.locatorKey, folderId));
      }
    } catch { /* External files and foreign drags cannot move a navigator item. */ }
    setDraggedItem(null);
  };
  const moveScopeId = blueprintToMove?.scopeId ?? folderToMove?.scopeId;
  const moveDestinations = moveScopeId ? blueprintFolderTree(folders.organization, moveScopeId).filter(({ folder }) =>
    !folderToMove || !blueprintFolderAncestors(folders.organization, folder.id).some(ancestor => ancestor.id === folderToMove.id)
  ) : [];
  const confirmMove = async (destinationId: string | null) => {
    const next = blueprintToMove
      ? moveBlueprintToFolder(folders.organization, blueprintToMove.scopeId, blueprintToMove.locatorKey, destinationId)
      : folderToMove ? moveBlueprintFolder(folders.organization, folderToMove.id, destinationId) : null;
    if (next && await folders.update(next)) { setBlueprintToMove(null); setFolderToMove(null); }
  };

  const renderPlanRow = (entry: ArchitectNavigatorPlanEntry, showScope = false) => {
    const isActive = entry.plan.id === activeArchitectPlanId &&
      (!activePlanContext?.targetBranch || entry.branchName === activePlanContext.targetBranch);
    const isPinned = pinnedPlanIds.includes(entry.locatorKey) ||
      (entries.filter((candidate) => candidate.plan.id === entry.plan.id).length === 1 &&
        pinnedPlanIds.includes(entry.plan.id));
    const isActivating = activatingPlanId === entry.locatorKey;
    const kind = getArchitectPlanKind(entry.plan);
    const capabilities = getArchitectPlanCrudCapabilities(entry.plan);
    const isMutating = mutatingPlanId === entry.locatorKey;
    const planMenuKey = `${showScope ? 'overview' : entry.scopeId}:${entry.locatorKey}`;
    return (
      <div
        key={planMenuKey}
        className={cn(
          'group/plan relative flex min-w-0 items-center rounded-md pr-1 transition-colors',
          isActive
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isBusy) return;
          setScopeCreateMenu(null);
          setScopeContextMenu(null);
          setOpenPlanMenuKey(planMenuKey);
        }}
      >
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void activatePlan(entry)}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70 disabled:cursor-default disabled:opacity-60"
          aria-current={isActive ? 'page' : undefined}
        >
          {isActivating || isMutating ? (
            <Icon name="loader" size={12} className="shrink-0 animate-spin text-primary" />
          ) : (
            <Icon name={getPlanIcon(entry.plan)} size={12} className={cn('shrink-0', isActive ? 'text-primary' : 'opacity-70')} />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className={cn('truncate text-xs', isActive && 'font-medium')}>{getArchitectPlanPrimaryName(entry.plan)}</span>
            </span>
            {showScope && <span className="block truncate text-[10px] text-muted-foreground/75">{entry.scopeLabel}</span>}
          </span>
          {!entry.plan.hasAgsdl && entry.scopeId !== macroScope?.id && <span
            className="max-w-14 shrink-0 truncate rounded bg-muted/65 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
            title={planKindHelp(kind)}
          >
            {planKindLabel(kind)}
          </span>}
        </button>
        <button
          type="button"
          onClick={() => togglePin(entry.locatorKey)}
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            isPinned ? 'opacity-100 text-primary' : 'opacity-0 group-hover/plan:opacity-100 group-focus-within/plan:opacity-100',
          )}
          title={isPinned
            ? t('architect.projectNavigator.unpin', 'Désépingler')
            : t('architect.projectNavigator.pin', 'Épingler')}
          aria-label={isPinned
            ? t('architect.projectNavigator.unpin', 'Désépingler')
            : t('architect.projectNavigator.pin', 'Épingler')}
        >
          <Icon name={isPinned ? 'pin-off' : 'pin'} size={11} />
        </button>
        <div className="relative" data-architect-plan-menu>
          <button
            type="button"
            onClick={() => {
              setScopeCreateMenu(null);
              setScopeContextMenu(null);
              setOpenPlanMenuKey((current) => current === planMenuKey ? null : planMenuKey);
            }}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 group-hover/plan:opacity-100 group-focus-within/plan:opacity-100',
              isActive ? 'opacity-100' : 'opacity-0',
            )}
            title={t('architect.projectNavigator.planActions', 'Actions du plan')}
            aria-label={t('architect.projectNavigator.planActions', 'Actions du plan')}
            aria-expanded={openPlanMenuKey === planMenuKey}
          >
            <Icon name="more-horizontal" size={12} />
          </button>
          {openPlanMenuKey === planMenuKey && (
            <div className="absolute right-0 top-8 z-30 w-44 rounded-lg border border-border bg-popover p-1.5 text-xs text-popover-foreground shadow-xl">
              {entry.plan.status !== 'archived' && entry.scopeId !== macroScope?.id && (
                <button type="button" disabled={isBusy || !folders.ready || folders.busy}
                  onClick={() => { setOpenPlanMenuKey(null); setBlueprintToMove(entry); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50">
                  <Icon name="folder" size={11} />{t('architect.projectNavigator.moveToFolder', 'Move to…')}
                </button>
              )}
              {entry.plan.status !== 'archived' && (
                <button
                  type="button"
                  onClick={() => {
                    setOpenPlanMenuKey(null);
                    togglePin(entry.locatorKey);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
                >
                  <Icon name={isPinned ? 'pin-off' : 'pin'} size={11} />
                  {isPinned
                    ? t('architect.projectNavigator.unpin', 'Désépingler')
                    : t('architect.projectNavigator.pin', 'Épingler')}
                </button>
              )}
              {capabilities.canEditDetails && (
                <button
                  type="button"
                  onClick={() => {
                    setOpenPlanMenuKey(null);
                    setFormError(null);
                    setPlanToEdit(entry);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
                >
                  <Icon name="edit" size={11} />
                  {t('architect.projectNavigator.rename', 'Renommer')}
                </button>
              )}
              {capabilities.canEditDetails && (
                <button type="button" onClick={() => { setOpenPlanMenuKey(null); setFormError(null); setPlanToChooseIcon(entry); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent">
                  <Icon name="palette" size={11} />
                  {t('architect.planIcon.title', 'Choose an icon')}
                </button>
              )}
              {(capabilities.canArchive || capabilities.canRestore) && (
                <button
                  type="button"
                  onClick={() => void archivePlan(entry)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
                >
                  <Icon name={entry.plan.status === 'archived' ? 'rotate-ccw' : 'archive'} size={11} />
                  {entry.plan.status === 'archived'
                    ? t('architect.projectNavigator.restore', 'Restaurer')
                    : t('architect.projectNavigator.archive', 'Archiver')}
                </button>
              )}
              {capabilities.canDelete && (
                <button
                  type="button"
                  onClick={() => {
                    setOpenPlanMenuKey(null);
                    setPlanToDelete(entry);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-red-400 hover:bg-red-500/10"
                >
                  <Icon name="trash" size={11} />
                  {t('architect.projectNavigator.delete', 'Supprimer')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const createMenuScope = scopeCreateMenu ? scopesById.get(scopeCreateMenu.scopeId) ?? null : null;
  const createMenuPlanKinds = createMenuScope
    ? getCreatableArchitectPlanKinds(createMenuScope.projects.map((project) => project.gitFlowSettings))
    : [];
  const createMenuPosition = scopeCreateMenu && typeof window !== 'undefined'
    ? getAnchoredArchitectMenuPosition(
        scopeCreateMenu.anchorRect,
        {
          width: SCOPE_CREATE_MENU_WIDTH,
          height: Math.max(152, createMenuPlanKinds.length * 44 + 96),
        },
        { width: window.innerWidth, height: window.innerHeight },
      )
    : null;
  const contextMenuScope = scopeContextMenu ? scopesById.get(scopeContextMenu.scopeId) ?? null : null;

  const createActions = createMenuScope ? createMenuPlanKinds.map((planKind) => {
    const isCreatingKind = creatingScopeId === createMenuScope.id && creatingPlanKind === planKind;
    const canCreatePlan = !isLoading && !error && createMenuScope.projects.some(isProjectPlanActionable);
    return (
      <button
        key={planKind}
        type="button"
        role="menuitem"
        disabled={isBusy || Boolean(creatingScopeId) || !canCreatePlan}
        onClick={() => void createPlan(createMenuScope, planKind)}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted/65 text-muted-foreground">
          <Icon
            name={isCreatingKind ? 'loader' : getPlanKindIconName(planKind)}
            size={12}
            className={cn(isCreatingKind && 'animate-spin text-primary')}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">
            {planKind === 'feature' ? agsdlT('agsdl.design.createSystem', { defaultValue: 'Create a system' }) : planKindLabel(planKind)}
          </span>
          <span className="block text-[10px] text-muted-foreground">
            {planKind === 'feature' ? agsdlT('agsdl.design.createSystemHelp', { defaultValue: 'Start from scratch or use a blueprint.' }) : planKindHelp(planKind)}
          </span>
        </span>
      </button>
    );
  }) : [];
  const scopeCreateMenuPortal = scopeCreateMenu && createMenuScope && createMenuPosition && typeof document !== 'undefined'
    ? createPortal(
        <div
          role="menu"
          aria-label={t('architect.projectNavigator.newPlan', 'Nouveau plan')}
          className="fixed z-[90] w-60 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-2xl"
          style={{ top: createMenuPosition.top, left: createMenuPosition.left, maxHeight: `calc(100vh - ${createMenuPosition.top + 12}px)`, overflowY: 'auto' }}
          data-architect-scope-menu
          data-architect-scope-create-menu
        >
          {createActions.filter((_, index) => createMenuPlanKinds[index] === 'feature')}
          {createMenuScope.id !== macroScope?.id && <button type="button" role="menuitem" disabled={!folders.ready || folders.busy || isBusy}
            onClick={() => openFolderForm(createMenuScope.id)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
            <span className="flex h-6 w-6 items-center justify-center"><Icon name="folder" size={12} /></span>
            {t('architect.projectNavigator.newFolder', 'New folder')}
          </button>}
          {createMenuPlanKinds.some(kind => kind !== 'feature') && <details className="mt-1 border-t border-border pt-1">
            <summary className="cursor-pointer rounded-md px-2 py-2 text-[11px] text-muted-foreground hover:bg-accent">
              {agsdlT('agsdl.design.otherPlanTypes', { defaultValue: 'Other plan types' })}
            </summary>
            {createActions.filter((_, index) => createMenuPlanKinds[index] !== 'feature')}
          </details>}
        </div>,
        document.body,
      )
    : null;

  const scopeContextMenuPortal = scopeContextMenu && contextMenuScope && typeof document !== 'undefined'
    ? createPortal(
        <div
          role="menu"
          aria-label={t('architect.projectNavigator.manageProjects', 'Gérer les projets')}
          className="fixed z-[90] w-52 rounded-lg border border-border bg-popover p-1.5 text-xs text-popover-foreground shadow-2xl"
          style={{ top: scopeContextMenu.position.top, left: scopeContextMenu.position.left }}
          data-architect-scope-menu
          data-architect-scope-context-menu
        >
          <button type="button" role="menuitem" disabled={!folders.ready || folders.busy || isBusy} onClick={() => openFolderForm(contextMenuScope.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
            <Icon name="folder" size={11} />{t('architect.projectNavigator.newFolder', 'New folder')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setScopeContextMenu(null);
              setScopeToRename(contextMenuScope);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="edit" size={11} />
            {t('common.rename', 'Renommer')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setScopeContextMenu(null);
              openProjectNavigator();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="settings" size={11} />
            {t('architect.projectNavigator.manageProjects', 'Gérer les projets')}
          </button>
        </div>,
        document.body,
      )
    : null;

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background" aria-label={t('architect.projectNavigator.title', 'Projets')}>
      {scopeCreateMenuPortal}
      {scopeContextMenuPortal}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        {isSearchOpen ? (
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t('architect.projectNavigator.searchPlans', 'Rechercher des plans...')}
            className="h-8 min-w-0 flex-1 rounded-md py-1 focus-within:border-border focus-within:ring-0"
            showClear={false}
            inputAutoFocus
            data-tour-id="architect-plan-search"
          />
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="folder-tree" size={15} className="shrink-0 text-primary" />
            <h2 className="truncate text-sm font-semibold text-foreground">{t('architect.projectNavigator.title', 'Projets')}</h2>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <PanelHeaderIconButton
            icon={isSearchOpen ? 'x' : 'search'}
            label={isSearchOpen
              ? t('common.close', 'Close')
              : t('architect.projectNavigator.searchPlans', 'Rechercher des plans...')}
            pressed={isSearchOpen}
            className={isSearchOpen ? 'h-8 w-8' : undefined}
            onClick={() => {
              if (isSearchOpen) setSearchQuery('');
              setIsSearchOpen((current) => !current);
            }}
            data-tour-id="architect-search-toggle"
          />
          {!isSearchOpen && (
            <>
          <PanelHeaderIconButton
            icon="archive"
            label={t('architect.projectNavigator.archives', 'Archives')}
            pressed={showArchived}
            onClick={() => {
              setOpenPlanMenuKey(null);
              setScopeCreateMenu(null);
              setScopeContextMenu(null);
              setArchitectShowArchived(!showArchived);
            }}
            data-tour-id="architect-archive-toggle"
          />
          <PanelHeaderIconButton
            icon="plus"
            label={t('architect.projectNavigator.addProject', 'Ajouter un projet')}
            onClick={() => openProjectModal(null)}
          />
          <PanelHeaderIconButton
            icon="settings"
            label={t('architect.projectNavigator.manageProjects', 'Gérer les projets')}
            onClick={openProjectNavigator}
          />
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2.5">
        {error && (
          <div className="mx-1 mb-2 rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-400" role="alert">
            {error}
          </div>
        )}

        {hasSearchQuery && (showArchived ? searchedArchivedEntries : searchedActiveEntries).length === 0 && (
          <div className="mx-2 mt-8 text-center">
            <Icon name="search" size={20} className="mx-auto mb-2 text-muted-foreground/45" />
            <p className="text-xs text-muted-foreground">
              {t('architect.projectNavigator.noSearchResults', 'Aucun plan ne correspond à cette recherche.')}
            </p>
          </div>
        )}

        {!showArchived && !hasSearchQuery && pinnedEntries.length > 0 && (
          <section className="mb-3.5" aria-labelledby="architect-pinned-plans-title">
            <h3 id="architect-pinned-plans-title" className="px-1.5 pb-1.5 pt-0.5 text-[11px] font-medium text-muted-foreground">
              {t('architect.projectNavigator.pinned', 'Épinglés')}
            </h3>
            <div className="space-y-1">{pinnedEntries.map((entry) => renderPlanRow(entry, true))}</div>
          </section>
        )}

        {!showArchived && macroScope && (!hasSearchQuery || macroEntries.length > 0) && (
          <section aria-label={t('architect.projectNavigator.macroBlueprints', 'Macro library')} className="mb-4">
            <div className="flex h-7 items-center gap-1 px-1.5">
              <h3 className="min-w-0 flex-1">
                <button
                  type="button"
                  aria-expanded={macroExpanded}
                  aria-controls="architect-macro-blueprints-content"
                  onClick={() => setSectionExpanded('macro', !macroExpanded)}
                  className="flex h-7 w-full items-center gap-1.5 rounded text-left text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70"
                >
                  <Icon name={macroExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
                  <span className="truncate">{t('architect.projectNavigator.macroBlueprints', 'Macro library')}</span>
                </button>
              </h3>
              <button type="button" disabled={isBusy || isLoading || !!creatingScopeId} onClick={() => void createPlan(macroScope, 'feature')} aria-label={t('architect.projectNavigator.newMacroBlueprint', 'New Macro blueprint')} className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"><Icon name={creatingScopeId === macroScope.id ? 'loader' : 'plus'} size={12} className={cn(creatingScopeId === macroScope.id && 'animate-spin')} /></button>
            </div>
            <div id="architect-macro-blueprints-content" hidden={!macroExpanded} className="space-y-0.5">{macroEntries.map(entry => renderPlanRow(entry))}</div>
          </section>
        )}

        {!showArchived ? (!hasSearchQuery || searchedActiveEntries.length > 0) && (
          <section aria-labelledby="architect-projects-title">
          <div className="flex h-7 items-center gap-1 px-1.5">
            <h3 id="architect-projects-title" className="min-w-0 flex-1">
              <button
                type="button"
                aria-expanded={projectsExpanded}
                aria-controls="architect-projects-content"
                onClick={() => setSectionExpanded('projects', !projectsExpanded)}
                className="flex h-7 w-full items-center gap-1.5 rounded text-left text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70"
              >
                <Icon name={projectsExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
                <span>{t('architect.projectNavigator.projects', 'Tous les projets')}</span>
              </button>
            </h3>
            <button
              type="button"
              onClick={() => void refreshPlans()}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              title={t('architect.projectNavigator.refresh', 'Actualiser')}
              aria-label={t('architect.projectNavigator.refresh', 'Actualiser')}
            >
              <Icon name="rotate-ccw" size={11} className={cn(isLoading && 'animate-spin')} />
            </button>
          </div>

          <div id="architect-projects-content" hidden={!projectsExpanded}>
          {!isLoading && projectScopes.length === 0 && (
            <div className="mx-2 mt-6 text-center">
              <Icon name="folder" size={22} className="mx-auto mb-2 text-muted-foreground/50" />
              <p className="text-xs text-muted-foreground">{t('architect.projectNavigator.noProjects', 'Aucun projet pour l’instant.')}</p>
              <button
                type="button"
                onClick={() => openProjectModal(null)}
                className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground hover:bg-accent"
              >
                <Icon name="plus" size={12} />
                {t('architect.projectNavigator.addProject', 'Ajouter un projet')}
              </button>
            </div>
          )}

          <div className="space-y-1">
            {displayedScopes.map((scope) => {
              const scopeEntries = entriesByScope.get(scope.id) ?? [];
              const isExpanded = hasSearchQuery || expandedScopeIds.includes(scope.id);
              const isSelected = scopeIsSelected(scope, selectedGroupId, selectedProjectId);
              const hasFolders = folders.organization.folders.some(folder => folder.scopeId === scope.id);
              const showAll = hasFolders || hasSearchQuery || expandedPlanLists.includes(scope.id);
              const visibleEntries = showAll ? scopeEntries : scopeEntries.slice(0, MAX_VISIBLE_PLANS_PER_SCOPE);
              const hiddenCount = scopeEntries.length - visibleEntries.length;
              const canCreatePlan = !isLoading && !error && scope.projects.some(isProjectPlanActionable);
              return (
                <div
                  key={scope.id}
                  className="relative"
                  data-architect-scope-id={scope.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (isBusy) return;
                    applyScopeSelection(scope);
                    setOpenPlanMenuKey(null);
                    setScopeCreateMenu(null);
                    setScopeContextMenu({
                      scopeId: scope.id,
                      position: getPointerArchitectMenuPosition(
                        { x: event.clientX, y: event.clientY },
                        { width: SCOPE_CONTEXT_MENU_WIDTH, height: 110 },
                        { width: window.innerWidth, height: window.innerHeight },
                      ),
                    });
                  }}
                >
                  <div className={cn(
                    'group/scope flex min-h-8 items-center rounded-md transition-colors',
                    rootDropScopeId === scope.id && 'bg-primary/10 ring-1 ring-inset ring-primary/60',
                    isSelected
                      ? 'bg-accent/80'
                      : 'hover:bg-accent/45',
                  )} data-architect-scope-menu
                    onDragEnter={event => {
                      if (!isBusy && folders.ready && !folders.busy && draggedItem?.scopeId === scope.id && (draggedItem.kind === 'blueprint' || canMoveBlueprintFolder(folders.organization, draggedItem.folderId, null))) {
                        event.preventDefault(); event.stopPropagation(); setRootDropScopeId(scope.id);
                      }
                    }}
                    onDragOver={(event) => {
                      if (!isBusy && folders.ready && !folders.busy && draggedItem?.scopeId === scope.id && (draggedItem.kind === 'blueprint' || canMoveBlueprintFolder(folders.organization, draggedItem.folderId, null))) {
                        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setRootDropScopeId(scope.id);
                      }
                    }}
                    onDragLeave={() => setRootDropScopeId(null)}
                    onDrop={event => dropBlueprint(scope.id, null, event)}
                  >
                    <button
                      type="button"
                      onClick={() => toggleScope(scope.id)}
                      className="flex h-8 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70"
                      aria-expanded={isExpanded}
                      aria-label={isExpanded
                        ? t('architect.projectNavigator.collapseProject', 'Réduire le projet')
                        : t('architect.projectNavigator.expandProject', 'Développer le projet')}
                    >
                      <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => selectAndToggleScope(scope)}
                      disabled={isBusy}
                      className="flex h-8 min-w-0 flex-1 items-center gap-2 pr-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70 disabled:opacity-60"
                    >
                      <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded', isSelected ? 'text-primary' : 'text-muted-foreground')}>
                        {scope.kind === 'project' && scope.projects[0] ? (
                          <ProjectIcon project={scope.projects[0]} fallbackIcon="layers" size={13} />
                        ) : (
                          <Icon name="layers" size={13} />
                        )}
                      </span>
                      <span className={cn('min-w-0 flex-1 truncate text-xs font-medium', isSelected ? 'text-foreground' : 'text-foreground/90')}>{scope.label}</span>
                    </button>
                    <button
                      ref={(element) => {
                        if (element) scopeCreateButtonRefs.current.set(scope.id, element);
                        else scopeCreateButtonRefs.current.delete(scope.id);
                      }}
                      type="button"
                      onClick={(event) => {
                        const anchor = event.currentTarget.getBoundingClientRect();
                        openScopeCreateMenu(scope.id, 'header', anchor);
                      }}
                      disabled={isBusy || creatingScopeId === scope.id || !canCreatePlan}
                      className={cn(
                        'mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 group-hover/scope:opacity-100 disabled:cursor-not-allowed disabled:opacity-30',
                        isSelected ? 'opacity-100' : 'opacity-0',
                      )}
                      title={t('architect.projectNavigator.newPlan', 'Nouveau plan')}
                      aria-label={t('architect.projectNavigator.newPlanFor', 'Nouveau plan pour {{project}}', { project: scope.label })}
                      aria-haspopup="menu"
                      aria-expanded={scopeCreateMenu?.scopeId === scope.id && scopeCreateMenu.triggerKey === 'header'}
                    >
                      <Icon name={creatingScopeId === scope.id ? 'loader' : 'plus'} size={11} className={cn(creatingScopeId === scope.id && 'animate-spin')} />
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="ml-7 space-y-0.5 pb-0.5 pt-0.5">
                      <BlueprintFolderTree scopeId={scope.id} entries={visibleEntries} organization={folders.organization}
                        disabled={isBusy || !folders.ready || folders.busy || Boolean(creatingScopeId)} searching={hasSearchQuery}
                        draggedItem={draggedItem} onDragChange={item => { setDraggedItem(item); setRootDropScopeId(null); }}
                        canCreateBlueprint={canCreatePlan && !creatingScopeId} onCreateBlueprint={folder => void createPlan(scope, 'feature', folder.id)}
                        onDropPlan={dropBlueprint} onUpdate={folders.update} onRename={folder => openFolderForm(scope.id, folder)} onCreate={folder => openFolderForm(scope.id, undefined, folder.id)} onMove={folder => setFolderToMove(folder)} renderPlan={renderPlanRow}>

                        <button
                          type="button"
                          onClick={(event) => {
                            const anchor = event.currentTarget.getBoundingClientRect();
                            openScopeCreateMenu(scope.id, 'empty', anchor);
                          }}
                          disabled={!canCreatePlan || isBusy}
                          aria-haspopup="menu"
                          aria-expanded={scopeCreateMenu?.scopeId === scope.id && scopeCreateMenu.triggerKey === 'empty'}
                          data-architect-scope-menu
                          className="mt-0.5 flex min-h-8 w-full items-center gap-2 rounded-md border border-dashed border-border/70 bg-muted/10 px-2 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-foreground disabled:cursor-default disabled:opacity-50"
                        >
                          <Icon name="plus" size={11} />
                          {t('architect.projectNavigator.firstPlan', 'Créer le premier plan')}
                        </button>
                      </BlueprintFolderTree>
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setExpandedPlanLists((current) => [...current, scope.id])}
                          className="w-full rounded-md px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          {t('architect.projectNavigator.showMore', 'Afficher {{count}} de plus', { count: hiddenCount })}
                        </button>
                      )}
                      {showAll && !hasFolders && scopeEntries.length > MAX_VISIBLE_PLANS_PER_SCOPE && (
                        <button
                          type="button"
                          onClick={() => setExpandedPlanLists((current) => current.filter((id) => id !== scope.id))}
                          className="w-full rounded-md px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          {t('architect.projectNavigator.showLess', 'Afficher moins')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </div>
          </section>
        ) : (
          <section aria-labelledby="architect-archived-plans-title">
            <h3 id="architect-archived-plans-title" className="px-1.5 pb-1.5 pt-0.5 text-[11px] font-medium text-muted-foreground">
              {t('architect.projectNavigator.archivedPlans', 'Plans archivés')}
            </h3>
            {searchedArchivedEntries.length > 0 ? (
              <div className="space-y-0.5">{searchedArchivedEntries.map((entry) => renderPlanRow(entry, true))}</div>
            ) : !hasSearchQuery ? (
              <div className="mx-2 mt-8 text-center">
                <Icon name="archive" size={20} className="mx-auto mb-2 text-muted-foreground/45" />
                <p className="text-xs text-muted-foreground">
                  {t('architect.projectNavigator.noArchivedPlans', 'Aucun plan archivé.')}
                </p>
              </div>
            ) : null}
          </section>
        )}
      </div>
      {planToChooseIcon && <PlanIconDialog value={planToChooseIcon.plan.icon} isLoading={formLoading} error={formError} onSelect={icon => void choosePlanIcon(icon)} onClose={() => { if (!formLoading) setPlanToChooseIcon(null); }} />}
      {planToEdit && (
        <PlanFormModal
          initialValue={getArchitectPlanEditableName(planToEdit.plan)}
          isCanonicalPlan={isCanonicalArchitectPlan(planToEdit.plan)}
          onConfirm={(value) => void editPlan(value)}
          onClose={() => {
            if (!formLoading) setPlanToEdit(null);
          }}
          isLoading={formLoading}
          error={formError}
        />
      )}

      <ConfirmPromptModal
        isOpen={Boolean(folderForm)}
        title={folderForm?.folder ? t('architect.projectNavigator.renameFolder', 'Rename folder') : folderForm?.parentId ? t('architect.projectNavigator.newSubfolder', 'New subfolder') : t('architect.projectNavigator.newFolder', 'New folder')}
        initialValue={folderForm?.folder?.name ?? ''} inputPlaceholder={t('common.name', 'Name')} requireInput
        confirmLabel={folderForm?.folder ? t('common.rename', 'Rename') : t('architect.planSelector.create', 'Create')}
        cancelLabel={t('common.cancel', 'Cancel')} isSubmitting={folders.busy}
        onCancel={() => { if (!folders.busy) setFolderForm(null); }} onConfirm={value => void confirmFolder(value ?? '')}>
        {folderError && <p role="alert" className="text-xs text-red-400">{folderError}</p>}
      </ConfirmPromptModal>
      <ConfirmPromptModal isOpen={Boolean(blueprintToMove || folderToMove)} title={t('architect.projectNavigator.moveToFolder', 'Move to…')}
        showConfirmButton={false} cancelLabel={t('common.cancel', 'Cancel')} isSubmitting={folders.busy}
        onCancel={() => { if (!folders.busy) { setBlueprintToMove(null); setFolderToMove(null); } }} onConfirm={() => undefined}>
        {moveScopeId && [{ folder: null, depth: 0, path: t('architect.projectNavigator.projectRoot', 'Project root') }, ...moveDestinations].map(({ folder, depth, path }) => {
          const currentId = blueprintToMove ? blueprintFolderId(folders.organization, moveScopeId, blueprintToMove.locatorKey) : folderToMove?.parentId ?? null;
          const selected = currentId === (folder?.id ?? null);
          const invalid = Boolean(folderToMove && !canMoveBlueprintFolder(folders.organization, folderToMove.id, folder?.id ?? null));
          return <button key={folder?.id ?? 'root'} type="button" disabled={folders.busy || selected || invalid} title={path}
            onClick={() => void confirmMove(folder?.id ?? null)}
            style={{ paddingLeft: 8 + (folder ? depth + 1 : 0) * 12 }}
            className="flex min-h-9 w-full items-center gap-2 rounded pr-2 text-left text-xs hover:bg-accent disabled:opacity-60">
            <Icon name={folder ? 'folder' : 'layers'} size={14} /><span className="min-w-0 flex-1 truncate">{folder?.name ?? path}</span>{selected && <Icon name="check" size={12} />}
          </button>;
        })}
      </ConfirmPromptModal>

      <ConfirmPromptModal
        isOpen={Boolean(scopeToRename)}
        title={t('common.rename', 'Renommer')}
        description={scopeToRename?.kind === 'group'
          ? t('projects.renameGroupPrompt', 'Entrez un nouveau nom pour ce groupe.')
          : t('projects.renameProjectPrompt', 'Entrez un nouveau nom pour ce projet.')}
        confirmLabel={t('common.rename', 'Renommer')}
        cancelLabel={t('common.cancel', 'Annuler')}
        initialValue={scopeToRename?.label ?? ''}
        inputPlaceholder={t('common.name', 'Nom')}
        requireInput
        isSubmitting={isRenamingScope}
        onCancel={() => {
          if (!isRenamingScope) setScopeToRename(null);
        }}
        onConfirm={(value) => void confirmScopeRename(value ?? '')}
      />

      <ConfirmPromptModal
        isOpen={Boolean(planToDelete)}
        title={t('architect.projectNavigator.deleteTitle', 'Supprimer le plan')}
        description={planToDelete
          ? t('architect.projectNavigator.deleteDescription', 'Le plan « {{name}} » et ses branches locales Macro seront supprimés. Cette action est irréversible.', {
              name: getArchitectPlanDisplayName(planToDelete.plan),
            })
          : ''}
        confirmLabel={isDeleting
          ? t('architect.projectNavigator.deleting', 'Suppression…')
          : t('architect.projectNavigator.delete', 'Supprimer')}
        cancelLabel={t('common.cancel', 'Annuler')}
        confirmVariant="error"
        onCancel={() => {
          if (!isDeleting) setPlanToDelete(null);
        }}
        onConfirm={() => void deletePlan()}
      />
    </aside>
  );
};

export default ArchitectProjectNavigator;
