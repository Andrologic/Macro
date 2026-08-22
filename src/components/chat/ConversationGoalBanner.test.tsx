import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import type { ConversationGoalRecord } from '../../types';
import { installReactI18nextMock } from '../../test-utils/reactI18nextMock';

const buildGoal = (
  status: ConversationGoalRecord['status'],
): ConversationGoalRecord => ({
  conversationId: 'conversation-1',
  goalId: 'goal-1',
  revision: 1,
  status,
  objective: 'Finish the authentication migration',
  providerId: null,
  modelId: null,
  reasoningEffort: null,
  createdAt: '2026-08-22T10:00:00.000Z',
  updatedAt: '2026-08-22T10:00:00.000Z',
  lastAuditedAt: null,
  lastExecutorTurnAt: null,
  awaitingUserSinceAt: null,
  executorTurnCount: 0,
  auditCount: 0,
  continuationCount: 0,
  latestVerdict: null,
  lastError: null,
});

describe('ConversationGoalBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    installReactI18nextMock();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mock.restore();
  });

  const renderBanner = async (
    status: ConversationGoalRecord['status'],
    onResume = mock(() => undefined),
  ) => {
    const { ConversationGoalBanner } = await import('./ConversationGoalBanner');
    await act(async () => {
      root.render(
        <ConversationGoalBanner
          goal={buildGoal(status)}
          onPause={() => undefined}
          onResume={onResume}
          onStop={() => undefined}
        />,
      );
    });
    return onResume;
  };

  it('shows the goal objective and the pending audit state', async () => {
    await renderBanner('audit_pending');

    expect(container.textContent).toContain('Goal mode');
    expect(container.textContent).toContain('Review pending');
    expect(container.textContent).toContain('Finish the authentication migration');
    expect(
      container.querySelector('[data-conversation-goal-banner]')?.getAttribute('data-goal-status'),
    ).toBe('audit_pending');
  });

  it('offers resume instead of pause for a paused goal', async () => {
    const onResume = await renderBanner('paused');
    const buttons = Array.from(container.querySelectorAll('button'));

    expect(buttons.some((button) => button.textContent?.trim() === 'Pause')).toBe(false);
    const resumeButton = buttons.find(
      (button) => button.textContent?.trim() === 'Resume tracking',
    );
    expect(resumeButton).toBeTruthy();
    await act(async () => resumeButton?.click());
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does not offer controls that can change an achieved goal', async () => {
    await renderBanner('achieved');

    expect(container.textContent).toContain('Goal achieved');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('announces criterion statuses without relying on color', async () => {
    const { ConversationGoalBanner } = await import('./ConversationGoalBanner');
    const goal = buildGoal('auditing');
    goal.latestVerdict = {
      verdict: 'continue',
      summary: 'More work is required.',
      criteria: [
        { criterion: 'Migration complete', status: 'met', evidence: [] },
        { criterion: 'Tests green', status: 'unmet', evidence: [] },
        { criterion: 'Deployment verified', status: 'uncertain', evidence: [] },
      ],
      feedback: 'Continue.',
      questionForUser: null,
      confidence: 0.8,
    };

    await act(async () => {
      root.render(
        <ConversationGoalBanner
          goal={goal}
          onPause={() => undefined}
          onResume={() => undefined}
          onStop={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain('Met: Migration complete');
    expect(container.textContent).toContain('Not met: Tests green');
    expect(container.textContent).toContain('Uncertain: Deployment verified');
    expect(container.querySelector('details summary')).not.toBeNull();
  });
});
