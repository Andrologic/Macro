import { describe, expect, it, mock } from 'bun:test';
import {
  isPlanActivationSwitchRequestCurrent,
  recoverFailedPlanActivation,
  resolvePlanActivationTargetBranch,
} from './planActivationRecovery';

interface VisibleAppState {
  activeArchitectPlanId: string;
  activePlanContext: {
    id: string;
    targetBranch: string;
  };
  architectPlanSwitch: {
    requestId: number;
    targetPlanId: string;
    targetBranch: string;
    status: string;
    startedAt: number;
    summaryHint: { id: string } | null;
    errorMessage: string | null;
  };
  pendingArchitectPlanActivationPayload: { planId: string } | null;
  planNodes: Array<{ id: string }>;
  predictedBranches: Array<{ id: string }>;
  strategyMutationPreview: { planId: string } | null;
}

describe('PlanSelector activation recovery', () => {
  it('uses the catalog branch for activation', () => {
    expect(resolvePlanActivationTargetBranch({
      exactCatalogBranch: 'release/2.0',
      unambiguousLegacyBranch: null,
      fallbackBranch: 'develop',
    })).toBe('release/2.0');
  });

  it('keeps the activation request current when hydration rewrites its branch', () => {
    expect(isPlanActivationSwitchRequestCurrent({
      activationSwitchRequestId: 8,
      planId: 'plan-b',
      currentSwitch: {
        requestId: 8,
        targetPlanId: 'plan-b',
      },
    })).toBe(true);
    expect(isPlanActivationSwitchRequestCurrent({
      activationSwitchRequestId: 8,
      planId: 'plan-b',
      currentSwitch: {
        requestId: 9,
        targetPlanId: 'plan-b',
      },
    })).toBe(false);
  });

  it('restores the exact visible state and reports the activation error', () => {
    const previousAppState: VisibleAppState = {
      activeArchitectPlanId: 'plan-a',
      activePlanContext: {
        id: 'plan-a',
        targetBranch: 'develop',
      },
      architectPlanSwitch: {
        requestId: 7,
        targetPlanId: 'plan-a',
        targetBranch: 'develop',
        status: 'ready',
        startedAt: 1,
        summaryHint: null,
        errorMessage: null,
      },
      pendingArchitectPlanActivationPayload: null,
      planNodes: [{ id: 'task-a' }],
      predictedBranches: [{ id: 'branch-a' }],
      strategyMutationPreview: { planId: 'plan-a' },
    };
    const previousChatState = {
      selectedConversationId: 'conversation-a',
      selectedConversationIdsByMode: {
        Architect: 'conversation-a',
        Chat: 'conversation-chat',
      },
      restoreStatus: 'ready',
      activeContextKey: 'Architect::plan::plan-a::develop::none::project-1',
      selectionRequestId: 5,
      pendingArchitectPlanSwitchRequestId: null,
      lastError: 'Previous conversation warning',
    };
    let appState: VisibleAppState = {
      activeArchitectPlanId: 'plan-b',
      activePlanContext: {
        id: 'plan-b',
        targetBranch: 'develop',
      },
      architectPlanSwitch: {
        requestId: 8,
        targetPlanId: 'plan-b',
        targetBranch: 'develop',
        status: 'error',
        startedAt: 2,
        summaryHint: { id: 'plan-b' },
        errorMessage: 'Plan activation failed',
      },
      pendingArchitectPlanActivationPayload: { planId: 'plan-b' },
      planNodes: [],
      predictedBranches: [],
      strategyMutationPreview: null,
    };
    let chatState = {
      selectedConversationId: null as string | null,
      selectedConversationIdsByMode: {
        Architect: null as string | null,
        Chat: 'conversation-chat',
      },
      restoreStatus: 'resolving',
      activeContextKey: 'Architect::plan::plan-b::develop::none::project-1',
      selectionRequestId: 8,
      pendingArchitectPlanSwitchRequestId: 8 as number | null,
      lastError: null as string | null,
    };
    const recoveryOrder: string[] = [];
    const setError = mock((message: string) => {
      recoveryOrder.push(`set-error:${message}`);
    });
    const notifyError = mock((message: string) => {
      recoveryOrder.push(`notify-error:${message}`);
    });

    const result = recoverFailedPlanActivation({
      previousAppState,
      previousChatState,
      invalidateConversationResolution: () => {
        recoveryOrder.push('invalidate-conversation');
        chatState = {
          ...chatState,
          selectionRequestId: chatState.selectionRequestId + 1,
          pendingArchitectPlanSwitchRequestId: null,
        };
      },
      restoreAppState: (state) => {
        recoveryOrder.push('restore-app');
        appState = state;
      },
      getChatSelectionRequestId: () => chatState.selectionRequestId,
      restoreChatState: (state) => {
        recoveryOrder.push('restore-chat');
        chatState = state;
      },
      error: new Error('The selected plan is unavailable.'),
      openReplicaRepair: () => false,
      resolveErrorMessage: () => 'The selected plan is unavailable.',
      setError,
      notifyError,
    });

    expect(result).toBe('error-reported');
    expect(appState).toEqual(previousAppState);
    expect(chatState).toEqual({
      ...previousChatState,
      selectionRequestId: 11,
    });
    expect(recoveryOrder).toEqual([
      'invalidate-conversation',
      'restore-app',
      'invalidate-conversation',
      'restore-chat',
      'set-error:The selected plan is unavailable.',
      'notify-error:The selected plan is unavailable.',
    ]);
    expect(setError).toHaveBeenCalledWith('The selected plan is unavailable.');
    expect(notifyError).toHaveBeenCalledWith('The selected plan is unavailable.');
  });
});
