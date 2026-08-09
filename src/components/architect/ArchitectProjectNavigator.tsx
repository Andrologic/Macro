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
import { getArchitectPlanKind } from '../../services/architectPlanKinds';
import {
  getArchitectPlanDisplayName,
  getArchitectPlanEditableName,
  getArchitectPlanPrimaryName,
  getArchitectPlanLifecyclePhase,
  isCanonicalArchitectPlan,
} from '../../services/architectPlanPresentation';
import { isProjectActionable } from '../../services/globalProjects';
import { loadMacroProjectMetadataForSelection } from '../../services/macroProjectMetadataLoader';
import { loadPreference, PREF_KEYS, savePreference } from '../../services/preferences';
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
  type ArchitectNavigatorPlanEntry,
  type ArchitectNavigatorScope,
} from './architectProjectNavigatorModel';

const MAX_VISIBLE_PLANS_PER_SCOPE = 7;

const summarizePlanRecord = (plan: ArchitectPlanRecord) => ({
  ...plan,
  nodeCount: plan.nodes.length,
  predictedBranchCount: plan.predictedBranches.length,
});

const planKindIcon = {
  feature: 'sparkles',
  release: 'milestone',
  hotfix: 'zap',
  bugfix: 'tool',
} as const;

const planPhaseDotClass: Record<string, string> = {
  draft: 'bg-muted-foreground/60',
  validated: 'bg-sky-500',
  in_progress: 'bg-amber-500',
  completed: 'bg-emerald-500',
  cancelled: 'bg-red-500',
  archived: 'bg-muted-foreground/40',
};

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
  const [activatingPlanId, setActivatingPlanId] = useState<string | null>(null);
  const [openPlanMenuId, setOpenPlanMenuId] = useState<string | null>(null);
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
    if (!selectedScope || expandedScopeIds.includes(selectedScope.id)) return;
    setExpandedScopeIds((current) => [...current, selectedScope.id]);
  }, [expandedScopeIds, selectedScope]);

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
    const next = expandedScopeIds.includes(scopeId)
      ? expandedScopeIds.filter((id) => id !== scopeId)
      : [...expandedScopeIds, scopeId];
    persistExpandedScopes(next);
  };

  const selectScope = useCallback((scope: ArchitectNavigatorScope) => {
    if (scope.kind === 'group') {
      setSelectedGroup(scope.groupId);
    } else {
      setSelectedProject(scope.projectId);
    }
    if (!expandedScopeIds.includes(scope.id)) {
      persistExpandedScopes([...expandedScopeIds, scope.id]);
    }
  }, [expandedScopeIds, persistExpandedScopes, setSelectedGroup, setSelectedProject]);

  const togglePin = (planId: string) => {
    const next = pinnedPlanIds.includes(planId)
      ? pinnedPlanIds.filter((id) => id !== planId)
      : [...pinnedPlanIds, planId];
    setPinnedPlanIds(next);
    void savePreference(PREF_KEYS.ARCHITECT_PINNED_PLAN_IDS, next);
  };

  const activatePlan = async (entry: ArchitectNavigatorPlanEntry) => {
    if (isBusy || entry.plan.status === 'archived') return;
    setActivatingPlanId(entry.plan.id);
    setError(null);
    try {
      const scope = scopesById.get(entry.scopeId);
      const activated = await activateArchitectPlan(entry.plan.id, {
        targetBranch: entry.branchName,
        planSummaryHint: entry.plan,
        scopedProjectIdsHint: scope?.projectIds ?? [],
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
    setOpenPlanMenuId(null);
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

  const createPlan = useCallback(async (scope: ArchitectNavigatorScope) => {
    if (creatingScopeId || isBusy) return;
    const editableProjectIds = scope.projects.filter(isProjectActionable).map((project) => project.id);
    const contextProjectIds = scope.projectIds.filter((projectId) => !editableProjectIds.includes(projectId));
    if (editableProjectIds.length === 0) {
      notify.warning(t('architect.projectNavigator.readOnlyScope', 'Ce projet est en lecture seule.'));
      return;
    }
    setCreatingScopeId(scope.id);
    setError(null);
    try {
      selectScope(scope);
      const result = await ensureScopedBlankPlan({
        branchName: getGitFlowBaseBranch(),
        scopedProjectIds: editableProjectIds,
        contextProjectIds,
        planKind: 'feature',
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
        if (selectedPlans.length === 0) void createPlan(selectedScope);
      } else {
        openProjectNavigator();
      }
    };
    window.addEventListener(ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT, handleRequest);
    return () => window.removeEventListener(ARCHITECT_PLAN_SELECTOR_REQUEST_EVENT, handleRequest);
  }, [createPlan, entriesByScope, expandedScopeIds, openProjectNavigator, persistExpandedScopes, selectedScope]);

  const renderPlanRow = (entry: ArchitectNavigatorPlanEntry, showScope = false) => {
    const isActive = entry.plan.id === activeArchitectPlanId;
    const isPinned = pinnedPlanIds.includes(entry.plan.id);
    const isActivating = activatingPlanId === entry.plan.id;
    const phase = getArchitectPlanLifecyclePhase(entry.plan);
    const kind = getArchitectPlanKind(entry.plan);
    const capabilities = getArchitectPlanCrudCapabilities(entry.plan);
    const isMutating = mutatingPlanId === entry.plan.id;
    return (
      <div
        key={`${showScope ? 'pinned' : entry.scopeId}:${entry.plan.id}`}
        className={cn(
          'group/plan relative flex min-w-0 items-center rounded-md pr-1 transition-colors',
          isActive ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <button
          type="button"
          disabled={isBusy || entry.plan.status === 'archived'}
          onClick={() => void activatePlan(entry)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 disabled:cursor-default disabled:opacity-60"
          aria-current={isActive ? 'page' : undefined}
        >
          {isActivating || isMutating ? (
            <Icon name="loader" size={12} className="shrink-0 animate-spin text-primary" />
          ) : (
            <Icon name={planKindIcon[kind]} size={12} className="shrink-0 opacity-75" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-xs">{getArchitectPlanPrimaryName(entry.plan)}</span>
            </span>
            {showScope && <span className="block truncate text-[10px] text-muted-foreground/75">{entry.scopeLabel}</span>}
          </span>
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', planPhaseDotClass[phase] ?? planPhaseDotClass.draft)} />
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
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenPlanMenuId((current) => current === entry.plan.id ? null : entry.plan.id)}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 group-hover/plan:opacity-100 group-focus-within/plan:opacity-100',
              isActive ? 'opacity-100' : 'opacity-0',
            )}
            title={t('architect.projectNavigator.planActions', 'Actions du plan')}
            aria-label={t('architect.projectNavigator.planActions', 'Actions du plan')}
            aria-expanded={openPlanMenuId === entry.plan.id}
          >
            <Icon name="more-horizontal" size={12} />
          </button>
          {openPlanMenuId === entry.plan.id && (
            <div className="absolute right-0 top-7 z-30 w-40 rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-lg">
              {capabilities.canEditDetails && (
                <button
                  type="button"
                  onClick={() => {
                    setOpenPlanMenuId(null);
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
                    setOpenPlanMenuId(null);
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
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-card" aria-label={t('architect.projectNavigator.title', 'Projets')}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="folder-tree" size={15} className="shrink-0 text-primary" />
          <h2 className="truncate text-sm font-semibold text-foreground">{t('architect.projectNavigator.title', 'Projets')}</h2>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => openProjectModal(null)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            title={t('architect.projectNavigator.addProject', 'Ajouter un projet')}
            aria-label={t('architect.projectNavigator.addProject', 'Ajouter un projet')}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button"
            onClick={openProjectNavigator}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            title={t('architect.projectNavigator.manageProjects', 'Gérer les projets')}
            aria-label={t('architect.projectNavigator.manageProjects', 'Gérer les projets')}
          >
            <Icon name="settings" size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
        {pinnedEntries.length > 0 && (
          <section className="mb-3" aria-labelledby="architect-pinned-plans-title">
            <h3 id="architect-pinned-plans-title" className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/75">
              {t('architect.projectNavigator.pinned', 'Épinglés')}
            </h3>
            <div className="space-y-0.5">{pinnedEntries.map((entry) => renderPlanRow(entry, true))}</div>
          </section>
        )}

        <section aria-labelledby="architect-projects-title">
          <div className="flex items-center justify-between px-2 pb-1 pt-1">
            <div className="flex items-center gap-1.5">
              <h3 id="architect-projects-title" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/75">
                {t('architect.projectNavigator.projects', 'Projets')}
              </h3>
              {scopes.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] tabular-nums text-muted-foreground">
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

          {error && (
            <div className="mx-1 mb-2 rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-400" role="alert">
              {error}
            </div>
          )}

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

          <div className="space-y-0.5">
            {scopes.map((scope) => {
              const scopeEntries = entriesByScope.get(scope.id) ?? [];
              const isExpanded = expandedScopeIds.includes(scope.id);
              const isSelected = scopeIsSelected(scope, selectedGroupId, selectedProjectId);
              const showAll = expandedPlanLists.includes(scope.id);
              const visibleEntries = showAll ? scopeEntries : scopeEntries.slice(0, MAX_VISIBLE_PLANS_PER_SCOPE);
              const hiddenCount = scopeEntries.length - visibleEntries.length;
              return (
                <div key={scope.id}>
                  <div className={cn('group/scope flex items-center rounded-md', isSelected && 'bg-accent/70')}>
                    <button
                      type="button"
                      onClick={() => toggleScope(scope.id)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      aria-expanded={isExpanded}
                      aria-label={isExpanded
                        ? t('architect.projectNavigator.collapseProject', 'Réduire le projet')
                        : t('architect.projectNavigator.expandProject', 'Développer le projet')}
                    >
                      <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => selectScope(scope)}
                      disabled={isBusy}
                      className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 disabled:opacity-60"
                    >
                      <Icon name="folder" size={13} className={cn('shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                      <span className={cn('min-w-0 flex-1 truncate text-xs font-medium', isSelected ? 'text-foreground' : 'text-foreground/90')}>{scope.label}</span>
                      {scopeEntries.length > 0 && <span className="text-[10px] tabular-nums text-muted-foreground">{scopeEntries.length}</span>}
                    </button>
                    <button
                      type="button"
                      onClick={() => void createPlan(scope)}
                      disabled={isBusy || creatingScopeId === scope.id || !scope.projects.some(isProjectActionable)}
                      className={cn(
                        'mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 group-hover/scope:opacity-100 disabled:cursor-not-allowed disabled:opacity-30',
                        isSelected ? 'opacity-100' : 'opacity-0',
                      )}
                      title={t('architect.projectNavigator.newPlan', 'Nouveau plan')}
                      aria-label={t('architect.projectNavigator.newPlanFor', 'Nouveau plan pour {{project}}', { project: scope.label })}
                    >
                      <Icon name={creatingScopeId === scope.id ? 'loader' : 'plus'} size={11} className={cn(creatingScopeId === scope.id && 'animate-spin')} />
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="ml-5 border-l border-border/70 pl-1.5">
                      {visibleEntries.length > 0 ? visibleEntries.map((entry) => renderPlanRow(entry)) : (
                        <button
                          type="button"
                          onClick={() => void createPlan(scope)}
                          disabled={!scope.projects.some(isProjectActionable) || isBusy}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
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
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {archivedEntries.length > 0 && (
          <section className="mt-3 border-t border-border/70 pt-2">
            <button
              type="button"
              onClick={() => setShowArchived((current) => !current)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/75 hover:bg-accent hover:text-foreground"
              aria-expanded={showArchived}
            >
              <Icon name={showArchived ? 'chevron-down' : 'chevron-right'} size={11} />
              {t('architect.projectNavigator.archived', 'Archivés')}
              <span className="ml-auto tabular-nums">{archivedEntries.length}</span>
            </button>
            {showArchived && <div className="mt-0.5 space-y-0.5">{archivedEntries.map((entry) => renderPlanRow(entry, true))}</div>}
          </section>
        )}
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
