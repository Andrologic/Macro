import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useNeedsStore } from '../../stores/useNeedsStore';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import type { NeedCategory } from '../../types';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../shared/Skeleton';
import { cn } from '../../utils/cn';
import {
  isCanonicalArchitectPlan,
  isDefaultNewPlanFamilyLabel,
} from '../../services/architectPlanPresentation';
import {
  isProjectWorkspaceMissing,
  resolveProjectWorkspaceState,
} from '../../services/projectWorkspaceState';
import { ProjectWorkspaceEmptyState } from '../shared/ProjectWorkspaceEmptyState';
import {
  NEED_CATEGORY_COLORS,
  NEED_CATEGORY_ICONS,
  NeedReferenceChip,
} from './NeedReferenceChip';

interface NeedsPanelProps {
  className?: string;
}

const IDLE_ARCHITECT_PLAN_SWITCH = {
  requestId: 0,
  targetPlanId: null,
  targetBranch: null,
  status: 'idle' as const,
  startedAt: null,
  summaryHint: null,
  errorMessage: null,
};

/**
 * NeedsPanel - Displays project requirements/needs in Architect mode
 * 
 * PERFORMANCE: Lazy loaded via ModeRouter, only rendered when Architect mode is active
 */
const NeedsPanel: React.FC<NeedsPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const { needs, selectNeed, selectedNeedId } = useNeedsStore(
    useShallow((state) => ({
      needs: state.needs,
      selectNeed: state.selectNeed,
      selectedNeedId: state.selectedNeedId,
    }))
  );
  const {
    activeArchitectPlanId,
    architectPlanSwitch,
    projectGroups,
    selectedGroupId,
    selectedProjectId,
  } = useAppStore(
    useShallow((state) => ({
      activeArchitectPlanId: state.activeArchitectPlanId,
      architectPlanSwitch:
        state.architectPlanSwitch ?? IDLE_ARCHITECT_PLAN_SWITCH,
      projectGroups: state.projectGroups,
      selectedGroupId: state.selectedGroupId,
      selectedProjectId: state.selectedProjectId,
    }))
  );
  const workspaceState = useMemo(
    () =>
      resolveProjectWorkspaceState({
        projectGroups,
        selectedGroupId,
        selectedProjectId,
      }),
    [projectGroups, selectedGroupId, selectedProjectId]
  );
  const isWorkspaceMissing = isProjectWorkspaceMissing(workspaceState);
  const [filter, setFilter] = useState<'all' | NeedCategory>('all');
  const isResolvingActivePlan =
    architectPlanSwitch.status === 'resolving' &&
    architectPlanSwitch.targetPlanId === activeArchitectPlanId;
  const isResolvingBlankPlan = Boolean(
    architectPlanSwitch.summaryHint &&
      isCanonicalArchitectPlan(architectPlanSwitch.summaryHint) &&
      isDefaultNewPlanFamilyLabel(architectPlanSwitch.summaryHint.label) &&
      architectPlanSwitch.summaryHint.nodeCount === 0 &&
      (architectPlanSwitch.summaryHint.predictedBranchCount ?? 0) === 0 &&
      (architectPlanSwitch.summaryHint.needCount ?? 0) === 0 &&
      (architectPlanSwitch.summaryHint.chatMessageCount ?? 0) === 0 &&
      !architectPlanSwitch.summaryHint.conversationId
  );

  const scopedNeeds = useMemo(() => {
    if (isResolvingActivePlan) {
      return [];
    }
    if (isWorkspaceMissing) return [];
    if (!activeArchitectPlanId) return [];
    return needs.filter((need) => need.planId === activeArchitectPlanId);
  }, [activeArchitectPlanId, isResolvingActivePlan, isWorkspaceMissing, needs]);

  const filteredNeeds = useMemo(() => {
    if (filter === 'all') return scopedNeeds;
    return scopedNeeds.filter((n) => n.category === filter);
  }, [scopedNeeds, filter]);

  const handleNeedClick = (needId: string) => {
    const need = needs.find((n) => n.id === needId);
    if (!need) return;
    selectNeed(need.id);
    const { addComposerContextRef } = useChatStore.getState();
    addComposerContextRef({
      id: need.id,
      kind: 'need',
      title: need.title,
      subtitle: need.category,
      data: need,
    });
  };

  if (isWorkspaceMissing) {
    return (
      <aside
        className={cn("h-full w-full bg-card border-r border-border flex items-center justify-center", className)}
        data-tour-id="architect-needs-panel"
      >
        <ProjectWorkspaceEmptyState
          stateKind={workspaceState.kind}
          variant="secondary"
          panelKind="needs"
        />
      </aside>
    );
  }

  if (isResolvingActivePlan && !isResolvingBlankPlan) {
    return (
      <aside
        className={cn("h-full w-full bg-card border-r border-border flex flex-col", className)}
        data-tour-id="architect-needs-panel"
      >
        <div className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
          <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Icon name="list" size={16} className="text-primary" />
            {t('architect.needs', 'Identified Needs')}
          </h1>
        </div>
        <div className="px-3 py-2 border-b border-border flex gap-1 overflow-x-auto no-scrollbar shrink-0">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={cn("h-full w-full bg-card border-r border-border flex flex-col", className)}
      data-tour-id="architect-needs-panel"
    >
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="list" size={16} className="text-primary" />
          {t('architect.needs', 'Identified Needs')}
          <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded-full ml-1">
            {scopedNeeds.length}
          </span>
        </h1>
      </div>

      {/* Filter Tabs */}
      <div
        className="px-3 py-2 border-b border-border flex gap-1 overflow-x-auto no-scrollbar shrink-0"
        data-tour-id="architect-need-filters"
      >
        <button
          onClick={() => setFilter('all')}
          className={cn(
            'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors shrink-0 inline-flex items-center justify-center leading-none',
            filter === 'all'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          {t('common.all', 'All')}
        </button>
        {(['functional', 'technical', 'ux', 'performance', 'security', 'data', 'business', 'other'] as NeedCategory[]).map((cat) => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={cn(
              'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 shrink-0',
              filter === cat
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <Icon name={NEED_CATEGORY_ICONS[cat]} size={12} className={NEED_CATEGORY_COLORS[cat]} />
            <span>{t(`architect.needCategory.${cat}`, cat)}</span>
          </button>
        ))}
      </div>

      {/* Needs List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filteredNeeds.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50 p-4 text-center">
            <Icon name="sparkles" size={32} className="mb-2" />
            <p className="text-sm">{t('architect.needsEmptyTitle', 'No needs identified for this project yet.')}</p>
            <p className="text-xs mt-1">{t('architect.needsEmptyDescription', 'Chat with the Architect to uncover project requirements.')}</p>
          </div>
        ) : (
          filteredNeeds.map((need) => (
            <NeedReferenceChip
              key={need.id}
              onClick={() => handleNeedClick(need.id)}
              need={need}
              title={need.title}
              surface="card"
              selected={selectedNeedId === need.id}
              priorityLabel={t(`architect.needPriority.${need.priority}`, need.priority)}
            />
          ))
        )}
      </div>

    </aside>
  );
};

// Export both named and default for lazy loading compatibility
export default NeedsPanel;
