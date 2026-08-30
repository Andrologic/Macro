import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ArchitectPlanSummary } from '../../services/architectPlanService';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../test-utils/reactI18nextMock';

const notifyErrorMock = mock((..._args: unknown[]) => undefined);
let PlanSelector!: typeof import('./PlanSelector').PlanSelector;

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  await Promise.resolve();
};

const buildPlan = (id: string, title: string): ArchitectPlanSummary => ({
  id,
  slug: id,
  title,
  description: `${title} description`,
  status: 'draft',
  targetBranch: 'develop',
  projectId: 'project-1',
  projectIds: ['project-1'],
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
  nodeCount: 1,
  predictedBranchCount: 1,
});

describe('PlanSelector', () => {
  const initialAppState = useAppStore.getState();
  const initialChatState = useChatStore.getState();
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeAll(async () => {
    installReactI18nextMock(createTranslationMock());
    mock.module('../ui/toastService', () => ({
      notify: {
        error: (...args: unknown[]) => notifyErrorMock(...args),
        success: mock(() => undefined),
        info: mock(() => undefined),
        warning: mock(() => undefined),
        actionRequired: mock(() => undefined),
      },
    }));
    ({ PlanSelector } = await import('./PlanSelector'));
  });

  beforeEach(() => {
    notifyErrorMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    document.body.innerHTML = '';
    root = null;
    container = null;
    useAppStore.setState(initialAppState, true);
    useChatStore.setState(initialChatState, true);
  });

  afterAll(() => {
    mock.restore();
  });

  it('restores the previous visible plan and notifies when activation fails', async () => {
    const firstPlan = buildPlan('plan-a', 'Plan A');
    const secondPlan = buildPlan('plan-b', 'Plan B');
    const previousPlanContext = {
      id: 'plan-a',
      slug: 'plan-a',
      title: 'Plan A',
      description: 'Plan A description',
      status: 'draft' as const,
      targetBranch: 'develop',
    };
    const previousNodes = [{
      id: 'task-a',
      title: 'Task A',
      type: 'task' as const,
      status: 'pending' as const,
      dependencies: [],
    }];
    const previousBranches = [{
      id: 'branch-a',
      name: 'feature/task-a',
      parentBranch: 'develop',
      projectId: 'project-1',
      color: '#60a5fa',
      status: 'pending' as const,
      taskIds: ['task-a'],
    }];
    const previousSwitch = {
      requestId: 7,
      targetPlanId: 'plan-a',
      targetBranch: 'develop',
      status: 'ready' as const,
      startedAt: 1,
      summaryHint: null,
      errorMessage: null,
    };
    const previousChatVisibleState = {
      selectedConversationId: 'conversation-a',
      selectedConversationIdsByMode: {
        Architect: 'conversation-a',
        Chat: 'conversation-chat',
      },
      restoreStatus: 'ready' as const,
      pendingArchitectPlanSwitchRequestId: null,
      lastError: 'Previous conversation warning',
    };
    const loadPlans = mock(async () => ({
      snapshot: {
        branchCatalogByBranch: {},
        branches: [{
          branchName: 'develop',
          activePlanId: 'plan-a',
          plans: [firstPlan, secondPlan],
          error: null,
        }],
        scannedBranchNames: ['develop'],
        scopedProjectIds: ['project-1'],
        visiblePlans: [firstPlan, secondPlan],
        modernPlanCount: 2,
        selectedPlan: firstPlan,
        selectedBranchName: 'develop',
        selectionReason: 'persisted' as const,
        errors: [],
      },
      selectedPlan: firstPlan,
      selectedBranchName: 'develop',
      selectionReason: 'persisted' as const,
    }));
    const activatePlan = mock(async () => {
      useAppStore.setState({
        activeArchitectPlanId: 'plan-b',
        activePlanContext: {
          id: 'plan-b',
          slug: 'plan-b',
          title: 'Plan B',
          description: 'Plan B description',
          status: 'draft',
          targetBranch: 'develop',
        },
        architectPlanSwitch: {
          requestId: 8,
          targetPlanId: 'plan-b',
          targetBranch: 'develop',
          status: 'error',
          startedAt: 2,
          summaryHint: secondPlan,
          errorMessage: 'Plan activation failed',
        },
        planNodes: [],
        predictedBranches: [],
        strategyMutationPreview: null,
      });
      useChatStore.setState({
        selectedConversationId: null,
        selectedConversationIdsByMode: {
          ...previousChatVisibleState.selectedConversationIdsByMode,
          Architect: null,
        },
        restoreStatus: 'resolving',
        pendingArchitectPlanSwitchRequestId: 8,
        lastError: null,
      });
      return false;
    });
    useAppStore.setState({
      standaloneProjects: [{
        id: 'project-1',
        name: 'Macro',
        mountName: 'macro',
        path: 'C:/repo/Macro',
        created_at: '2026-08-30T00:00:00.000Z',
        status: 'active',
        metadata: {
          description: '',
          tags: [],
          team_members: [],
          api_contracts: [],
          dependencies: [],
        },
      }],
      projectGroups: [],
      selectedGroupId: null,
      selectedProjectId: 'project-1',
      activeArchitectPlanId: 'plan-a',
      activePlanContext: previousPlanContext,
      architectPlanSwitch: previousSwitch,
      pendingArchitectPlanActivationPayload: null,
      planNodes: previousNodes,
      predictedBranches: previousBranches,
      strategyMutationPreview: null,
      loadMacroProjectMetadataForSelection: loadPlans as never,
      activateArchitectPlan: activatePlan as never,
    });
    useChatStore.setState(previousChatVisibleState);

    await act(async () => {
      root?.render(<PlanSelector />);
      await flushRender();
    });
    expect(document.body.textContent).toContain('Plan A');

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button')?.click();
      await flushRender();
    });
    const secondPlanButton = Array.from(document.body.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((element) => element.textContent?.includes('Plan B'));
    await act(async () => {
      secondPlanButton?.click();
      await flushRender();
    });

    const state = useAppStore.getState();
    expect(state.activeArchitectPlanId).toBe('plan-a');
    expect(state.activePlanContext).toEqual(previousPlanContext);
    expect(state.architectPlanSwitch).toEqual(previousSwitch);
    expect(state.planNodes).toEqual(previousNodes);
    expect(state.predictedBranches).toEqual(previousBranches);
    expect(useChatStore.getState()).toMatchObject(previousChatVisibleState);
    expect(document.body.querySelector<HTMLButtonElement>('button')?.textContent).toContain('Plan A');
    expect(notifyErrorMock).toHaveBeenCalledWith('The selected plan is unavailable.');
  });
});
