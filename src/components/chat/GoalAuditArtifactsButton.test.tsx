import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { useConversationGoalStore } from '../../stores/useConversationGoalStore';
import { createRoot, type Root } from 'react-dom/client';
import type { GoalAuditArtifact } from '../../composition/goalArtifactComposition';

const artifact = (projectId: string, conversationId: string, goalId: string): GoalAuditArtifact => ({
  id: 'audit-1', projectId, conversationId, goalId, goalRevision: 2,
  executorTurnId: 'turn-1', runId: 'run-1', messageId: 'message-1', kind: 'goal_audit',
  title: 'Goal review', summary: 'Verified', contentType: 'json', contentHash: '12345678',
  path: `branches/develop/goals/${conversationId}/${goalId}/artifacts/audit-1.json`,
  createdAt: '2026-01-01', review: { status: 'applied', verdict: 'achieved' },
});

let list: (projectId: string, conversationId: string, goalId: string) => Promise<GoalAuditArtifact[]> = async () => [];
let read: (item: GoalAuditArtifact) => Promise<string> = async () => '{}';
mock.module('../../composition/goalArtifactComposition', () => ({
  listConversationGoalAuditArtifacts: (projectId: string, conversationId: string, goalId: string) => list(projectId, conversationId, goalId),
  readGoalAuditArtifact: (item: GoalAuditArtifact) => read(item),
  saveGoalAuditArtifact: async () => null,
}));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
mock.module('../ui/DiffMergeView', () => ({ DiffMergeView: ({ modified }: { modified: string }) => <pre>{modified}</pre> }));

const { GoalAuditArtifactsButton } = await import('./GoalAuditArtifactsButton');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('Goal audit artifact navigation', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(async () => {
    await act(async () => { root?.unmount(); await flush(); });
    container?.remove();
    root = null; container = null;
    document.body.innerHTML = '';
    list = async () => [];
    read = async () => '{}';
    useConversationGoalStore.setState({ artifactRevisionByConversationId: {} });
  });

  const mount = async (projectId: string, conversationId: string, goalId: string | undefined, refreshKey = 1) => {
    if (!root) { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); }
    await act(async () => { root!.render(<GoalAuditArtifactsButton projectId={projectId} conversationId={conversationId} goalId={goalId} refreshKey={refreshKey} />); await flush(); });
  };
  const clickRetry = async () => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((candidate) => candidate.textContent === 'Retry');
    await act(async () => { button?.click(); await flush(); });
  };

  it('clears the previous conversation and project before showing another goal', async () => {
    list = async (projectId, conversationId, goalId) => [artifact(projectId, conversationId, goalId)];
    read = async (item) => `content for ${item.conversationId}`;
    await mount('project-1', 'conversation-1', 'goal-1');
    await act(async () => { container!.querySelector('button')!.click(); await flush(); });
    expect(document.body.textContent).toContain('content for conversation-1');
    await mount('project-2', 'conversation-2', 'goal-2');
    expect(document.body.textContent).not.toContain('content for conversation-1');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the loaded content when selecting the current artifact again', async () => {
    list = async (projectId, conversationId, goalId) => [artifact(projectId, conversationId, goalId)];
    read = async () => 'Verified Goal verdict';
    await mount('project-1', 'conversation-1', 'goal-1');
    await act(async () => { container!.querySelector('button')!.click(); await flush(); });
    const selected = document.querySelector<HTMLButtonElement>('[role="dialog"] nav button');
    expect(document.body.textContent).toContain('Verified Goal verdict');
    await act(async () => { selected!.click(); await flush(); });
    expect(document.body.textContent).toContain('Verified Goal verdict');
  });

  it('shows a review saved after Stop without requiring a goal or reload', async () => {
    let saved = false;
    const cancelled = { ...artifact('project-1', 'conversation-1', 'old-goal'), review: { status: 'cancelled' as const, verdict: null } };
    list = async () => saved ? [cancelled] : [];
    read = async () => 'Cancelled review of the original goal';
    await mount('project-1', 'conversation-1', undefined);
    expect(container!.querySelector('button')).toBeNull();
    saved = true;
    await act(async () => {
      useConversationGoalStore.getState().markArtifactSaved('conversation-1');
      await flush();
    });
    expect(container!.textContent).toContain('Goal reviews 1');
    await act(async () => { container!.querySelector('button')!.click(); await flush(); });
    expect(document.body.textContent).toContain('Cancelled review of the original goal');
  });

  it('shows index errors and retries a failed content read', async () => {
    list = async () => { throw new Error('Index unavailable'); };
    await mount('project-1', 'conversation-1', 'goal-1');
    await act(async () => { container!.querySelector('button')!.click(); await flush(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Index unavailable');
    list = async () => [artifact('project-1', 'conversation-1', 'goal-1')];
    read = async () => { throw new Error('Content unavailable'); };
    await clickRetry();
    await mount('project-1', 'conversation-1', 'goal-1', 2);
    await act(async () => { container!.querySelector('button')!.click(); await flush(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Content unavailable');
    read = async () => 'Recovered content';
    await clickRetry();
    expect(document.body.textContent).toContain('Recovered content');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
