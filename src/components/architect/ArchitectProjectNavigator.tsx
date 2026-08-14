import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ensureScopedBlankPlan } from '../../services/architectAutoPlan';
import {
  archiveArchitectPlan,
  getArchitectPlan,
  getArchitectPlanCrudCapabilities,
  getGitFlowBaseBranch,
  restoreArchitectPlan,
  updateArchitectPlan,
  type ArchitectPlanRecord,
} from '../../services/architectPlanService';
import { cleanupPlanBranches, deletePlanAndCleanupBranches } from '../../services/architectGitFlowService';
import {
  getArchitectPlanKind,
  getCreatableArchitectPlanKinds,
  type ArchitectPlanKind,
} from '../../services/architectPlanKinds';
import {
  getArchitectPlanDisplayName,
  getArchitectPlanEditableName,
  getArchitectPlanPrimaryName,
  isCanonicalArchitectPlan,
} from '../../services/architectPlanPresentation';
import { isProjectActionable } from '../../services/globalProjects';
import { loadMacroProjectMetadataForSelection } from '../../services/macroProjectMetadataLoader';
import { loadPreference, PREF_KEYS, savePreference } from '../../services/preferences';
import { getPlanKindIconName } from '../../services/planKindPresentation';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useTaskStore } from '../../stores/useTaskStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { notify } from '../ui/toastService';
import { PlanFormModal } from './PlanFormModal';
import {
  ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT,
  ARCHITECT_PLAN_SELECTOR_STATE_EVENT,
  type ArchitectPlanSelectorRequestDetail,
  type ArchitectPlanSelectorStateDetail,
} from './planSelectorEvents';
import {
  buildArchitectNavigatorPlanEntries,
  buildArchitectNavigatorScopes,
  sanitizeArchitectNavigatorIds,
  toggleArchitectNavigatorScope,
  type ArchitectNavigatorPlanEntry,
  type ArchitectNavigatorScope,
} from './architectProjectNavigatorModel';

const MAX_VISIBLE_PLANS_PER_SCOPE = 7;

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
  catalogLoader?: typeof loadMacroProjectMetadataForSelection;
}

export const ArchitectProjectNavigator: React.FC<ArchitectProjectNavigatorProps> = ({
  catalogLoader = loadMacroProjectMetadataForSelection,
}) => {
  const { t } = useTranslation();
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

  const [entries, setEntries] = useState<ArchitectNavigatorPlanEntry[]>([]);
  const [expandedScopeIds, setExpandedScopeIds] = useState<string[]>([]);
  const [pinnedPlanIds, setPinnedPlanIds] = useState<string[]>([]);
  const [expandedPlanLists, setExpandedPlanLists] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [creatingScopeId, setCreatingScopeId] = useState<string | null>(null);
  const [creatingPlanKind, setCreatingPlanKind] = useState<ArchitectPlanKind | null>(null);
  const [activatingPlanId, setActivatingPlanId] = useState<string | null>(null);
  const [openPlanMenuKey, setOpenPlanMenuKey] = useState<string | null>(null);
  const [openScopeMenuId, setOpenScopeMenuId] = useState<string | null>(null);
  const [planToEdit, setPlanToEdit] = useState<ArchitectNavigatorPlanEntry | null>(null);
  const [planToDelete, setPlanToDelete] = useState<ArchitectNavigatorPlanEntry | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [mutatingPlanId, setMutatingPlanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

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
  const entriesByScope = useMemo(() => {
    const result = new Map<string, ArchitectNavigatorPlanEntry[]>();
    for (const entry of activeEntries) {
      const current = result.get(entry.scopeId) ?? [];
      current.push(entry);
      result.set(entry.scopeId, current);
    }
    return result;
  }, [activeEntries]);
  const pinnedEntries = useMemo(() => {
    const pinned = new Set(pinnedPlanIds);
    return activeEntries.filter((entry) => pinned.has(entry.plan.id));
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
    void Promise.all([
      loadPreference<unknown>(PREF_KEYS.ARCHITECT_PINNED_PLAN_IDS),
      loadPreference<unknown>(PREF_KEYS.ARCHITECT_NAVIGATOR_EXPANDED_SCOPE_IDS),
    ]).then(([storedPins, storedScopes]) => {
      if (cancelled) return;
      const validScopeIds = new Set(scopes.map((scope) => scope.id));
      const sanitizedScopes = sanitizeArchitectNavigatorIds(storedScopes, validScopeIds);
      setPinnedPlanIds(sanitizeArchitectNavigatorIds(storedPins));
      setExpandedScopeIds(
        sanitizedScopes.length > 0
          ? sanitizedScopes
          : scopes.length <= 3
            ? scopes.map((scope) => scope.id)
            : selectedScope
              ? [selectedScope.id]
              : scopes[0]
                ? [scopes[0].id]
                : [],
      );
    });
    return () => {
      cancelled = true;
    };
  }, [scopes, selectedScope]);

  useEffect(() => {
    void refreshPlans();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refreshPlans]);

  useEffect(() => {
    const selectedPlans = selectedScope ? entriesByScope.get(selectedScope.id) ?? [] : [];
    const detail: ArchitectPlanSelectorStateDetail = {
      status: error ? 'error' : isLoading ? 'loading' : 'ready',
      planCount: selectedPlans.length,
      canCreate: Boolean(selectedScope?.projects.some(isProjectActionable)),
      canSelect: selectedPlans.length > 0,
    };
    window.dispatchEvent(new CustomEvent(ARCHITECT_PLAN_SELECTOR_STATE_EVENT, { detail }));
  }, [entriesByScope, error, isLoading, selectedScope]);

  const persistExpandedScopes = useCallback((next: string[]) => {
    setExpandedScopeIds(next);
    void savePreference(PREF_KEYS.ARCHITECT_NAVIGATOR_EXPANDED_SCOPE_IDS, next);
  }, []);

  const toggleScope = (scopeId: string) => {
    setOpenScopeMenuId(null);
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
    setOpenScopeMenuId(null);
    applyScopeSelection(scope);
    persistExpandedScopes(toggleArchitectNavigatorScope(expandedScopeIds, scope.id));
  }, [applyScopeSelection, expandedScopeIds, persistExpandedScopes]);

  const togglePin = (planId: string) => {
    const next = pinnedPlanIds.includes(planId)
      ? pinnedPlanIds.filter((id) => id !== planId)
      : [...pinnedPlanIds, planId];
    setPinnedPlanIds(next);
    void savePreference(PREF_KEYS.ARCHITECT_PINNED_PLAN_IDS, next);
  };

  const activatePlan = async (entry: ArchitectNavigatorPlanEntry) => {
    if (isBusy) return;
    setActivatingPlanId(entry.plan.id);
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

  const archivePlan = async (entry: ArchitectNavigatorPlanEntry) => {
    if (mutatingPlanId) return;
    setOpenPlanMenuKey(null);
    setMutatingPlanId(entry.plan.id);
    let releaseMutation: (() => void) | null = null;
    try {
      if (entry.plan.status === 'archived') {
        await restoreArchitectPlan(entry.branchName, entry.plan.id);
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
        const cleanup = await cleanupPlanBranches(latest);
        taskStore.clearPlanRuntimeState({
          planId: entry.plan.id,
          deletedWorktreeKeys: cleanup.flatMap((repository) =>
            repository.deletedWorktrees.map((worktree) => worktree.worktreeKey)),
        });
        await archiveArchitectPlan(entry.branchName, entry.plan.id);
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
  ) => {
    if (creatingScopeId || isBusy) return;
    const editableProjectIds = scope.projects.filter(isProjectActionable).map((project) => project.id);
    const contextProjectIds = scope.projectIds.filter((projectId) => !editableProjectIds.includes(projectId));
    if (editableProjectIds.length === 0) {
      notify.warning(t('architect.projectNavigator.readOnlyScope', 'Ce projet est en lecture seule.'));
      return;
    }
    setOpenScopeMenuId(null);
    setCreatingScopeId(scope.id);
    setCreatingPlanKind(planKind);
    setError(null);
    try {
      selectScope(scope);
      const result = await ensureScopedBlankPlan({
        branchName: getGitFlowBaseBranch(),
        scopedProjectIds: editableProjectIds,
        contextProjectIds,
        planKind,
        trigger: 'explicit_create',
      });
      if (!result) throw new Error(t('architect.projectNavigator.createError', 'Impossible de créer le plan.'));
      const activated = await activateArchitectPlan(result.plan.id, {
        targetBranch: result.plan.targetBranch,
        planSummaryHint: summarizePlanRecord(result.plan),
        scopedProjectIdsHint: scope.projectIds,
      });
      if (!activated) throw new Error(t('architect.projectNavigator.createError', 'Impossible de créer le plan.'));
      await refreshPlans();
      notify.success(t('architect.projectNavigator.planReady', 'Nouveau plan prêt.'));
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
  }, [activateArchitectPlan, creatingScopeId, isBusy, refreshPlans, selectScope, t]);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<ArchitectPlanSelectorRequestDetail>).detail;
      if (detail?.action !== 'primary') return;
      if (selectedScope) {
        if (!expandedScopeIds.includes(selectedScope.id)) {
          persistExpandedScopes([...expandedScopeIds, selectedScope.id]);
        }
        const selectedPlans = entriesByScope.get(selectedScope.id) ?? [];
        if (selectedPlans.length === 0) {
          setLeftPanelOpen(true);
          setOpenPlanMenuKey(null);
          setOpenScopeMenuId(selectedScope.id);
        }
      } else {
        openProjectNavigator();
      }
    };
    window.addEventListener(ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT, handleRequest);
    return () => window.removeEventListener(ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT, handleRequest);
  }, [entriesByScope, expandedScopeIds, openProjectNavigator, persistExpandedScopes, selectedScope, setLeftPanelOpen]);

  useEffect(() => {
    if (!openPlanMenuKey && !openScopeMenuId) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Element
        && event.target.closest('[data-architect-plan-menu], [data-architect-scope-menu]')
      ) return;
      setOpenPlanMenuKey(null);
      setOpenScopeMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenPlanMenuKey(null);
        setOpenScopeMenuId(null);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [openPlanMenuKey, openScopeMenuId]);

  const renderPlanRow = (entry: ArchitectNavigatorPlanEntry, showScope = false) => {
    const isActive = entry.plan.id === activeArchitectPlanId;
    const isPinned = pinnedPlanIds.includes(entry.plan.id);
    const isActivating = activatingPlanId === entry.plan.id;
    const kind = getArchitectPlanKind(entry.plan);
    const capabilities = getArchitectPlanCrudCapabilities(entry.plan);
    const isMutating = mutatingPlanId === entry.plan.id;
    const planMenuKey = `${showScope ? 'overview' : entry.scopeId}:${entry.plan.id}`;
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
          setOpenScopeMenuId(null);
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
            <Icon name={getPlanKindIconName(kind)} size={12} className={cn('shrink-0', isActive ? 'text-primary' : 'opacity-70')} />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className={cn('truncate text-xs', isActive && 'font-medium')}>{getArchitectPlanPrimaryName(entry.plan)}</span>
            </span>
            {showScope && <span className="block truncate text-[10px] text-muted-foreground/75">{entry.scopeLabel}</span>}
          </span>
          <span
            className="max-w-14 shrink-0 truncate rounded bg-muted/65 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
            title={planKindHelp(kind)}
          >
            {planKindLabel(kind)}
          </span>
        </button>
        <button
          type="button"
          onClick={() => togglePin(entry.plan.id)}
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
              setOpenScopeMenuId(null);
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
              {entry.plan.status !== 'archived' && (
                <button
                  type="button"
                  onClick={() => {
                    setOpenPlanMenuKey(null);
                    togglePin(entry.plan.id);
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

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background" aria-label={t('architect.projectNavigator.title', 'Projets')}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="folder-tree" size={15} className="shrink-0 text-primary" />
          <h2 className="truncate text-sm font-semibold text-foreground">{t('architect.projectNavigator.title', 'Projets')}</h2>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => openProjectModal(null)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            title={t('architect.projectNavigator.addProject', 'Ajouter un projet')}
            aria-label={t('architect.projectNavigator.addProject', 'Ajouter un projet')}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button"
            onClick={openProjectNavigator}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            title={t('architect.projectNavigator.manageProjects', 'Gérer les projets')}
            aria-label={t('architect.projectNavigator.manageProjects', 'Gérer les projets')}
          >
            <Icon name="settings" size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2.5">
        {error && (
          <div className="mx-1 mb-2 rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-400" role="alert">
            {error}
          </div>
        )}

        {!showArchived && pinnedEntries.length > 0 && (
          <section className="mb-3.5" aria-labelledby="architect-pinned-plans-title">
            <h3 id="architect-pinned-plans-title" className="px-1.5 pb-1.5 pt-0.5 text-[11px] font-medium text-muted-foreground">
              {t('architect.projectNavigator.pinned', 'Épinglés')}
            </h3>
            <div className="space-y-1">{pinnedEntries.map((entry) => renderPlanRow(entry, true))}</div>
          </section>
        )}

        {!showArchived ? (
          <section aria-labelledby="architect-projects-title">
          <div className="flex items-center justify-between px-1.5 pb-1.5 pt-0.5">
            <div className="flex items-center gap-1.5">
              <h3 id="architect-projects-title" className="text-[11px] font-medium text-muted-foreground">
                {t('architect.projectNavigator.projects', 'Tous les projets')}
              </h3>
              {scopes.length > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted/70 px-1 text-[9px] tabular-nums text-muted-foreground">
                  {scopes.length}
                </span>
              )}
            </div>
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

          {!isLoading && scopes.length === 0 && (
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
            {scopes.map((scope) => {
              const scopeEntries = entriesByScope.get(scope.id) ?? [];
              const isExpanded = expandedScopeIds.includes(scope.id);
              const isSelected = scopeIsSelected(scope, selectedGroupId, selectedProjectId);
              const showAll = expandedPlanLists.includes(scope.id);
              const visibleEntries = showAll ? scopeEntries : scopeEntries.slice(0, MAX_VISIBLE_PLANS_PER_SCOPE);
              const hiddenCount = scopeEntries.length - visibleEntries.length;
              const canCreatePlan = scope.projects.some(isProjectActionable);
              const creatablePlanKinds = getCreatableArchitectPlanKinds(
                scope.projects.map((project) => project.gitFlowSettings),
              );
              return (
                <div
                  key={scope.id}
                  className="relative"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (isBusy) return;
                    applyScopeSelection(scope);
                    setOpenPlanMenuKey(null);
                    setOpenScopeMenuId(scope.id);
                  }}
                >
                  <div className={cn(
                    'group/scope flex min-h-8 items-center rounded-md transition-colors',
                    isSelected
                      ? 'bg-accent/80'
                      : 'hover:bg-accent/45',
                  )} data-architect-scope-menu>
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
                      <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded', isSelected ? 'bg-primary/10 text-primary' : 'text-muted-foreground')}>
                        <Icon name="folder" size={13} />
                      </span>
                      <span className={cn('min-w-0 flex-1 truncate text-xs font-medium', isSelected ? 'text-foreground' : 'text-foreground/90')}>{scope.label}</span>
                      {scopeEntries.length > 0 && (
                        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted/60 px-1 text-[9px] tabular-nums text-muted-foreground">
                          {scopeEntries.length}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                    setOpenPlanMenuKey(null);
                        setOpenScopeMenuId((current) => current === scope.id ? null : scope.id);
                      }}
                      disabled={isBusy || creatingScopeId === scope.id || !canCreatePlan}
                      className={cn(
                        'mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 group-hover/scope:opacity-100 disabled:cursor-not-allowed disabled:opacity-30',
                        isSelected ? 'opacity-100' : 'opacity-0',
                      )}
                      title={t('architect.projectNavigator.newPlan', 'Nouveau plan')}
                      aria-label={t('architect.projectNavigator.newPlanFor', 'Nouveau plan pour {{project}}', { project: scope.label })}
                    >
                      <Icon name={creatingScopeId === scope.id ? 'loader' : 'plus'} size={11} className={cn(creatingScopeId === scope.id && 'animate-spin')} />
                    </button>
                  </div>

                  {openScopeMenuId === scope.id && (
                    <div
                      className="absolute right-0 top-8 z-40 w-60 max-w-[calc(100%-0.5rem)] rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
                      data-architect-scope-menu
                    >
                      <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium text-muted-foreground">
                        {t('architect.projectNavigator.newPlanFor', 'Nouveau plan pour {{project}}', { project: scope.label })}
                      </p>
                      {creatablePlanKinds.map((planKind) => {
                        const isCreatingKind = creatingScopeId === scope.id && creatingPlanKind === planKind;
                        return (
                          <button
                            key={planKind}
                            type="button"
                            disabled={isBusy || Boolean(creatingScopeId) || !canCreatePlan}
                            onClick={() => void createPlan(scope, planKind)}
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
                                {planKindLabel(planKind)}
                              </span>
                              <span className="block truncate text-[10px] text-muted-foreground">
                                {planKindHelp(planKind)}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                      <div className="my-1 border-t border-border/70" />
                      <button
                        type="button"
                        onClick={() => toggleScope(scope.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <Icon name={isExpanded ? 'chevron-right' : 'chevron-down'} size={11} />
                        {isExpanded
                          ? t('architect.projectNavigator.collapseProject', 'Réduire le projet')
                          : t('architect.projectNavigator.expandProject', 'Développer le projet')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenScopeMenuId(null);
                          openProjectNavigator();
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <Icon name="settings" size={11} />
                        {t('architect.projectNavigator.manageProjects', 'Gérer les projets')}
                      </button>
                    </div>
                  )}

                  {isExpanded && (
                    <div className="ml-7 space-y-0.5 pb-0.5 pt-0.5">
                      {visibleEntries.length > 0 ? visibleEntries.map((entry) => renderPlanRow(entry)) : (
                        <button
                          type="button"
                          onClick={() => {
                            setOpenPlanMenuKey(null);
                            setOpenScopeMenuId(scope.id);
                          }}
                          disabled={!canCreatePlan || isBusy}
                          className="mt-0.5 flex min-h-8 w-full items-center gap-2 rounded-md border border-dashed border-border/70 bg-muted/10 px-2 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-foreground disabled:cursor-default disabled:opacity-50"
                        >
                          <Icon name="plus" size={11} />
                          {t('architect.projectNavigator.firstPlan', 'Créer le premier plan')}
                        </button>
                      )}
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setExpandedPlanLists((current) => [...current, scope.id])}
                          className="w-full rounded-md px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          {t('architect.projectNavigator.showMore', 'Afficher {{count}} de plus', { count: hiddenCount })}
                        </button>
                      )}
                      {showAll && scopeEntries.length > MAX_VISIBLE_PLANS_PER_SCOPE && (
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
          </section>
        ) : (
          <section aria-labelledby="architect-archived-plans-title">
            <h3 id="architect-archived-plans-title" className="px-1.5 pb-1.5 pt-0.5 text-[11px] font-medium text-muted-foreground">
              {t('architect.projectNavigator.archivedPlans', 'Plans archivés')}
            </h3>
            {archivedEntries.length > 0 ? (
              <div className="space-y-0.5">{archivedEntries.map((entry) => renderPlanRow(entry, true))}</div>
            ) : (
              <div className="mx-2 mt-8 text-center">
                <Icon name="archive" size={20} className="mx-auto mb-2 text-muted-foreground/45" />
                <p className="text-xs text-muted-foreground">
                  {t('architect.projectNavigator.noArchivedPlans', 'Aucun plan archivé.')}
                </p>
              </div>
            )}
          </section>
        )}
      </div>

      <div className="flex h-12 shrink-0 items-center justify-between border-t border-border bg-card px-3">
        <span className="text-xs text-muted-foreground">
          {showArchived
            ? t('architect.projectNavigator.archivedPlanCount', '{{count}} plans archivés', { count: archivedEntries.length })
            : t('architect.projectNavigator.activePlanCount', '{{count}} plans actifs', { count: activeEntries.length })}
        </span>
        <button
          type="button"
          onClick={() => {
            setOpenPlanMenuKey(null);
            setOpenScopeMenuId(null);
            setShowArchived((current) => !current);
          }}
          data-tour-id="architect-archive-toggle"
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <Icon name={showArchived ? 'arrow-left' : 'archive'} size={12} />
          {showArchived
            ? t('architect.projectNavigator.activePlans', 'Plans actifs')
            : t('architect.projectNavigator.archives', 'Archives')}
        </button>
      </div>
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
