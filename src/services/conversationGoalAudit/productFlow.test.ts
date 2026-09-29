import { describe, expect, it } from 'bun:test';
import type { ChatMessage, ConversationGoalVerdict } from '../../types';
import type { GoalCasOutcome } from '../../types/generated/ipc';
import { useConversationGoalStore } from '../../stores/useConversationGoalStore';
import { ConversationGoalProductFlow, type GoalProductFlowPorts } from './productFlow';
import type { PersistedConversationGoalRecord } from './productRepository';
import type { GoalAuditResult } from './types';

const verdict = (kind: ConversationGoalVerdict['verdict']): ConversationGoalVerdict => ({
  verdict: kind,
  summary: 'Checked the objective.',
  criteria: [{ criterion: 'Complete the task', status: kind === 'achieved' ? 'met' : 'unmet', evidence: [{ source: 'test', finding: 'Observed the result.' }] }],
  feedback: 'Finish the remaining work.', questionForUser: null, confidence: 0.8,
});

const initialGoal = (): PersistedConversationGoalRecord => ({
  conversationId: 'conversation', goalId: 'goal', revision: 1, status: 'executor_running',
  objective: 'Complete the task', successCriteria: ['Complete the task'],
  providerId: 'provider', modelId: 'model', reasoningEffort: null,
  createdAt: '2026-01-01', updatedAt: '2026-01-01', lastAuditedAt: null,
  lastExecutorTurnAt: null, awaitingUserSinceAt: null, executorTurnCount: 0,
  auditCount: 0, continuationCount: 0, latestVerdict: null, lastError: null,
});

const assistant: ChatMessage = {
  id: 'assistant', turn_id: 'turn', conversation_id: 'conversation', task_id: '',
  role: 'assistant', content: 'Work completed.', timestamp: '2026-01-01', completion_reason: 'completed',
};

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const harness = (result: GoalAuditResult | Promise<GoalAuditResult> | ((turnId: string) => GoalAuditResult | Promise<GoalAuditResult>),
  sendOverride?: () => Promise<{ status: string; turnId: string; assistantMessageId: string | null }>) => {
  let goal: PersistedConversationGoalRecord | null = initialGoal();
  let runtime: { phase: string; turnId?: string | null } = { phase: 'idle' };
  let messages = [assistant];
  let queued = 0;
  let queuedTurnIds: string[] = [];
  let attemptedTurnIds: string[] = [];
  let listener: (() => void) | null = null;
  const saved: Array<{ auditId: string; turnId: string; result: GoalAuditResult }> = [];
  const artifactFailures: string[] = [];
  const flowFailures: string[] = [];
  const flowRetries: Array<() => Promise<void>> = [];
  const sent: string[] = [];
  const audited: string[] = [];
  const repository: GoalProductFlowPorts['repository'] = {
    loadCurrentGoal: async () => goal,
    activateGoal: async () => { goal = initialGoal(); return goal; },
    replaceGoal: async () => { goal = initialGoal(); return goal; },
    updateGoalStatus: async (current, status, reason): Promise<GoalCasOutcome> => {
      if (!goal || current.goalId !== goal.goalId || current.revision !== goal.revision) return 'stale';
      goal = { ...goal, revision: goal.revision + 1, status,
        lastError: status === 'error' ? reason ?? null : null,
        executorTurnCount: goal.executorTurnCount + (status === 'audit_pending' ? 1 : 0) };
      return 'applied';
    },
    stopGoal: async (current): Promise<GoalCasOutcome> => {
      if (!goal || current.revision !== goal.revision) return 'stale';
      goal = null;
      return 'applied';
    },
  };
  const ports: GoalProductFlowPorts = {
    repository,
    readRuntime: () => runtime,
    readMessages: () => messages,
    readQueuedCount: () => queued,
    readQueuedTurnIds: () => queuedTurnIds,
    readQueuedAttemptedTurnIds: () => attemptedTurnIds,
    sendContinuation: async (_id, content) => {
      sent.push(content);
      runtime = { phase: 'streaming', turnId: 'next-turn' };
      return sendOverride ? sendOverride() : { status: 'sent', turnId: 'next-turn', assistantMessageId: 'next-assistant' };
    },
    audit: (_current, turnId) => {
      audited.push(turnId);
      return ({
      runId: 'run', auditId: 'audit', cancel: () => true,
      result: Promise.resolve(typeof result === 'function' ? result(turnId) : result).then((value) => {
        if (value.status === 'applied' && goal) goal = { ...goal, revision: goal.revision + 1,
          status: value.verdict.verdict === 'achieved' ? 'achieved' :
            value.verdict.verdict === 'needs_user' ? 'awaiting_user' :
              value.verdict.verdict === 'cannot_progress' ? 'paused' : 'continuation_pending',
          latestVerdict: value.verdict,
          continuationCount: goal.continuationCount + (value.verdict.verdict === 'continue' ? 1 : 0) };
        return value;
      }),
    }); },
    saveArtifact: async (input) => { saved.push(input); },
    listRecoverable: async () => [],
    subscribe: (next) => { listener = next; return () => { listener = null; }; },
    publish: (id, value) => useConversationGoalStore.getState().hydrateGoal(id, value),
    onArtifactFailure: (message) => { artifactFailures.push(message); },
    onFlowFailure: (_id, message, retry) => { flowFailures.push(message); flowRetries.push(retry); },
  };
  const flow = new ConversationGoalProductFlow(ports);
  return { flow, saved, sent, audited, repository, ports, artifactFailures, flowFailures, flowRetries, notify: () => listener?.(),
    get goal() { return goal; }, set goal(value: PersistedConversationGoalRecord | null) { goal = value; },
    set runtime(value: typeof runtime) { runtime = value; listener?.(); },
    set messages(value: ChatMessage[]) { messages = value; listener?.(); },
    set queued(value: number) { queued = value; },
    set queuedTurnIds(value: string[]) { queuedTurnIds = value; listener?.(); },
    set attemptedTurnIds(value: string[]) { attemptedTurnIds = value; listener?.(); },
  };
};

describe('Goal product flow', () => {
  it('uses the persisted assistant turn for an audit, saves an artifact and completes', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    expect(h.saved).toMatchObject([{ auditId: 'audit', turnId: 'turn', result: { status: 'applied' } }]);
    expect(h.goal?.status).toBe('achieved');
    expect(h.sent).toHaveLength(0);
    expect(useConversationGoalStore.getState().goalsByConversationId.conversation?.status).toBe('achieved');
  });

  for (const [kind, expectedStatus] of [
    ['needs_user', 'awaiting_user'], ['cannot_progress', 'paused'],
  ] as const) {
    it(`keeps ${kind} visible without an automatic continuation`, async () => {
      const h = harness({ status: 'applied', runId: 'run', verdict: verdict(kind) });
      h.flow.track('conversation', 'turn', 'assistant', 'goal');
      await settle();
      expect(h.goal?.status).toBe(expectedStatus);
      expect(h.sent).toHaveLength(0);
      expect(h.saved[0]?.result.status).toBe('applied');
    });
  }

  it('continues once with bounded feedback after an applied review', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    expect(h.saved).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain('Finish the remaining work.');
    expect(h.goal?.status).toBe('executor_running');
    h.flow.cancel('conversation');
  });

  it('stops automatic continuation and reports a failed artifact write', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    h.ports.saveArtifact = async () => { throw new Error('disk unavailable'); };
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    expect(h.goal?.status).toBe('error');
    expect(h.goal?.lastError).toContain('disk unavailable');
    expect(h.artifactFailures).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
  });

  it('retains an achieved native verdict when artifact storage fails', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.ports.saveArtifact = async () => { throw new Error('disk unavailable'); };
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    expect(h.goal?.status).toBe('achieved');
    expect(h.artifactFailures).toHaveLength(1);
    expect(h.saved).toHaveLength(0);
  });

  it('reports a repository write error without starting an audit', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    const update = h.repository.updateGoalStatus;
    let first = true;
    h.repository.updateGoalStatus = async (...args) => {
      if (first) { first = false; throw new Error('repository unavailable'); }
      return update(...args);
    };
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    expect(h.goal?.status).toBe('error');
    expect(h.goal?.lastError).toContain('repository unavailable');
    expect(h.audited).toHaveLength(0);
  });

  it('resumes a paused goal by sending an executor turn', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), revision: 2, status: 'paused' };
    await h.flow.resume('conversation');
    expect(h.sent).toHaveLength(1);
    expect(h.goal?.status).toBe('executor_running');
    h.flow.cancel('conversation');
  });

  it('defers continuation behind queued user work and starts when idle', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    h.queued = 1;
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    expect(h.goal?.status).toBe('continuation_pending');
    expect(h.sent).toHaveLength(0);
    h.queued = 0;
    h.notify();
    await settle();
    expect(h.sent).toHaveLength(1);
    h.flow.cancel('conversation');
  });

  it('gives an admitted user turn priority when the queue clears', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    h.queued = 1;
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    const current = await h.flow.reserveUserTurn('conversation');
    expect(current?.status).toBe('continuation_pending');
    h.queued = 0;
    h.notify();
    await settle();
    expect(h.sent).toHaveLength(0);
    h.flow.releaseUserTurn('conversation');
    await settle();
    expect(h.sent).toHaveLength(1);
    h.flow.cancel('conversation');
  });

  it('invalidates an audit before admitting a new user turn', async () => {
    let resolve!: (value: GoalAuditResult) => void;
    const pending = new Promise<GoalAuditResult>((done) => { resolve = done; });
    const h = harness(pending);
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    const admitted = await h.flow.reserveUserTurn('conversation');
    expect(admitted?.status).toBe('active_ready');
    const running = await h.flow.status('conversation', 'executor_running', null, admitted!);
    expect(running?.status).toBe('executor_running');
    h.runtime = { phase: 'streaming', turnId: 'user-turn' };
    h.flow.track('conversation', 'user-turn', 'user-assistant', 'goal');
    h.flow.releaseUserTurn('conversation');
    resolve({ status: 'stale', runId: 'run', reason: 'revision_changed', verdict: verdict('continue') });
    await settle();
    expect(h.goal?.status).toBe('executor_running');
    expect(h.sent).toHaveLength(0);
  });

  it('rechecks the Goal when a verdict wins the admission CAS', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    h.goal = { ...initialGoal(), status: 'auditing' };
    const update = h.repository.updateGoalStatus;
    let raced = false;
    h.repository.updateGoalStatus = async (...args) => {
      if (!raced) {
        raced = true;
        h.goal = { ...h.goal!, revision: h.goal!.revision + 1, status: 'continuation_pending' };
        return 'stale';
      }
      return update(...args);
    };
    const admitted = await h.flow.reserveUserTurn('conversation');
    expect(admitted?.status).toBe('continuation_pending');
    const running = await h.flow.status('conversation', 'executor_running', null, admitted!);
    expect(running?.status).toBe('executor_running');
    h.flow.releaseUserTurn('conversation');
  });

  it('tracks a queued user turn when its assistant response appears', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'continuation_pending' };
    h.queuedTurnIds = ['queued-turn'];
    h.queued = 1;
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.messages = [{ ...assistant, id: 'queued-user', role: 'user', turn_id: 'queued-turn', content: 'Next request' },
      { ...assistant, id: 'queued-assistant', turn_id: 'queued-turn', content: 'Done' }];
    h.queuedTurnIds = [];
    h.queued = 0;
    h.runtime = { phase: 'idle' };
    await settle();
    expect(h.audited).toContain('queued-turn');
    expect(h.goal?.status).toBe('achieved');
    expect(h.sent).toHaveLength(0);
  });

  it('waits for the queued assistant placeholder and does not churn native revisions', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'continuation_pending' };
    h.queuedTurnIds = ['queued-turn'];
    h.queued = 1;
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.runtime = { phase: 'streaming', turnId: 'queued-turn' };
    h.messages = [{ ...assistant, id: 'queued-user', role: 'user', turn_id: 'queued-turn' }];
    await settle();
    expect(h.goal?.status).toBe('continuation_pending');
    const revision = h.goal?.revision;
    h.notify();
    await settle();
    expect(h.goal?.revision).toBe(revision);
    h.messages = [{ ...assistant, id: 'queued-user', role: 'user', turn_id: 'queued-turn' },
      { ...assistant, id: 'queued-assistant', turn_id: 'queued-turn', content: '' }];
    await settle();
    expect(h.goal?.status).toBe('executor_running');
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn', content: 'Completed' }];
    h.queuedTurnIds = [];
    h.queued = 0;
    h.runtime = { phase: 'idle' };
    await settle();
    expect(h.goal?.status).toBe('achieved');
  });

  it('resumes into an existing user queue without sending an extra turn', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'paused' };
    h.queuedTurnIds = ['queued-turn'];
    h.queued = 1;
    await h.flow.resume('conversation');
    expect(h.goal?.status).toBe('active_ready');
    expect(h.sent).toHaveLength(0);
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn', content: 'Completed' }];
    h.queuedTurnIds = [];
    h.queued = 0;
    h.runtime = { phase: 'idle' };
    await settle();
    expect(h.goal?.status).toBe('achieved');
  });

  it('keeps an accepted queued response for audit across Pause and Resume', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.queuedTurnIds = ['queued-turn'];
    h.queued = 1;
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    await h.flow.pause('conversation');
    h.queuedTurnIds = [];
    h.queued = 0;
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn', content: 'Completed' }];
    h.runtime = { phase: 'idle' };
    await settle();
    expect(h.goal?.status).toBe('paused');
    await h.flow.resume('conversation');
    await settle();
    expect(h.audited).toContain('queued-turn');
    expect(h.goal?.status).toBe('achieved');
    expect(h.sent).toHaveLength(0);
  });

  it('keeps a queued assistant placeholder across Pause until its completed response is reviewed', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'continuation_pending' };
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn', content: '' }];
    h.runtime = { phase: 'streaming', turnId: 'queued-turn' };
    await settle();
    expect(h.goal?.status).toBe('executor_running');
    await h.flow.pause('conversation');
    h.queuedTurnIds = [];
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn', content: 'Completed' }];
    h.runtime = { phase: 'idle' };
    await h.flow.resume('conversation');
    await settle();
    expect(h.audited).toContain('queued-turn');
    expect(h.goal?.status).toBe('achieved');
    expect(h.sent).toHaveLength(0);
  });

  it('retries queued admission when an audit verdict wins the native CAS', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'auditing' };
    const update = h.repository.updateGoalStatus;
    let raced = false;
    h.repository.updateGoalStatus = async (...args) => {
      if (!raced) {
        raced = true;
        h.goal = { ...h.goal!, revision: h.goal!.revision + 1, status: 'continuation_pending' };
        return 'stale';
      }
      return update(...args);
    };
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn' }];
    h.queuedTurnIds = [];
    h.runtime = { phase: 'idle' };
    await settle();
    expect(h.audited).toContain('queued-turn');
    expect(h.goal?.status).toBe('achieved');
    expect(h.flowFailures).toHaveLength(0);
  });

  it('offers a retry when native admission and error persistence both fail', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'continuation_pending' };
    const load = h.repository.loadCurrentGoal;
    let calls = 0;
    h.repository.loadCurrentGoal = async (...args) => {
      if (calls++ < 2) throw new Error('database unavailable');
      return load(...args);
    };
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn' }];
    h.queuedTurnIds = [];
    h.runtime = { phase: 'idle' };
    await settle();
    expect(h.goal?.status).toBe('continuation_pending');
    expect(h.flowFailures).toEqual(['database unavailable']);
    await h.flowRetries[0]();
    await settle();
    expect(h.audited).toContain('queued-turn');
    expect(h.goal?.status).toBe('achieved');
  });

  it('surfaces a repository failure while admitting a queued turn', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'continuation_pending' };
    const load = h.repository.loadCurrentGoal;
    let failed = false;
    h.repository.loadCurrentGoal = async (...args) => {
      if (!failed) { failed = true; throw new Error('repository unavailable'); }
      return load(...args);
    };
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn' }];
    await settle();
    expect(h.flowFailures).toEqual(['repository unavailable']);
    expect(h.goal?.status).toBe('error');
    expect(h.audited).toHaveLength(0);
  });

  it('Stop prevents a late audit from restarting the goal', async () => {
    let resolve!: (value: GoalAuditResult) => void;
    const pending = new Promise<GoalAuditResult>((done) => { resolve = done; });
    const h = harness(pending);
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    await h.flow.stop('conversation');
    resolve({ status: 'stale', runId: 'run', reason: 'goal_missing', verdict: verdict('continue') });
    await settle();
    expect(h.goal).toBeNull();
    expect(h.sent).toHaveLength(0);
  });

  it('retries Stop when a verdict wins its first native CAS', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    const stop = h.repository.stopGoal;
    let raced = false;
    h.repository.stopGoal = async (...args) => {
      if (!raced) {
        raced = true;
        h.goal = { ...h.goal!, revision: h.goal!.revision + 1, status: 'continuation_pending' };
        return 'stale';
      }
      return stop(...args);
    };
    await h.flow.stop('conversation');
    expect(h.goal).toBeNull();
  });

  it('does not let the cancelled review A clear the resumed turn B', async () => {
    let resolveA!: (value: GoalAuditResult) => void;
    const pendingA = new Promise<GoalAuditResult>((done) => { resolveA = done; });
    const h = harness((turnId) => turnId === 'turn' ? pendingA :
      { status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    await h.flow.pause('conversation');
    await h.flow.resume('conversation');
    expect(h.goal?.status).toBe('executor_running');
    h.messages = [{ ...assistant, id: 'next-assistant', turn_id: 'next-turn', content: 'New result' }];
    h.runtime = { phase: 'idle' };
    resolveA({ status: 'cancelled', runId: 'run', reason: 'parent_cancelled' });
    await settle();
    expect(h.audited).toContain('next-turn');
    expect(h.goal?.status).toBe('achieved');
  });

  it('does not mistake a live audit for an interrupted one during hydration', async () => {
    let resolve!: (value: GoalAuditResult) => void;
    const pending = new Promise<GoalAuditResult>((done) => { resolve = done; });
    const h = harness(pending);
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    await h.flow.hydrate('conversation');
    expect(h.goal?.status).toBe('audit_pending');
    resolve({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    await settle();
    expect(h.goal?.status).toBe('achieved');
  });

  it('pauses after two identical no-progress reviews instead of limiting useful turns', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    expect(h.sent).toHaveLength(1);
    h.messages = [{ ...assistant, id: 'next-assistant', turn_id: 'next-turn', content: 'No new result' }];
    h.runtime = { phase: 'idle' };
    await settle();
    expect(h.goal?.status).toBe('paused');
    expect(h.sent).toHaveLength(1);
  });

  it('does not restart a paused goal when continuation send resolves late', async () => {
    let resolveSend!: (value: { status: string; turnId: string; assistantMessageId: string | null }) => void;
    const sending = new Promise<{ status: string; turnId: string; assistantMessageId: string | null }>((done) => { resolveSend = done; });
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') }, () => sending);
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    await h.flow.pause('conversation');
    resolveSend({ status: 'sent', turnId: 'next-turn', assistantMessageId: 'next-assistant' });
    await settle();
    expect(h.goal?.status).toBe('paused');
    expect(h.audited).toEqual(['turn']);
  });

  it('pauses an interrupted goal on reload and exposes invalid verdicts as errors', async () => {
    const h = harness({ status: 'failed', runId: 'run', error: { code: 'INVALID_AUDITOR_VERDICT', message: 'Malformed output' } });
    await h.flow.hydrate('conversation');
    expect(h.goal?.status).toBe('paused');
    h.goal = { ...initialGoal(), revision: 3 };
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    expect(h.goal?.status).toBe('error');
    expect(h.goal?.lastError).toContain('INVALID_AUDITOR_VERDICT');
    expect(h.sent).toHaveLength(0);
  });

  it('does not return a replacement as the result of an earlier status write', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'active_ready' };
    const update = h.repository.updateGoalStatus;
    h.repository.updateGoalStatus = async (...args) => {
      const outcome = await update(...args);
      h.goal = { ...initialGoal(), goalId: 'replacement', status: 'active_ready' };
      return outcome;
    };
    expect(await h.flow.status('conversation', 'executor_running')).toBeNull();
    expect(h.goal?.goalId).toBe('replacement');
  });

  it('does not stop a replacement after a stale Stop result', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    let calls = 0;
    h.repository.stopGoal = async () => {
      calls += 1;
      h.goal = { ...initialGoal(), goalId: 'replacement', status: 'active_ready' };
      return 'stale';
    };
    await h.flow.stop('conversation');
    expect(calls).toBe(1);
    expect(h.goal?.goalId).toBe('replacement');
  });

  for (const action of ['stop', 'pause'] as const) {
    it(`discards a queued admission read that resolves after ${action}`, async () => {
      const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
      h.goal = { ...initialGoal(), status: 'continuation_pending' };
      const snapshot = h.goal;
      const load = h.repository.loadCurrentGoal;
      let resolve!: (goal: PersistedConversationGoalRecord | null) => void;
      const reading = new Promise<PersistedConversationGoalRecord | null>((done) => { resolve = done; });
      let first = true;
      h.repository.loadCurrentGoal = (...args) => {
        if (first) { first = false; return reading; }
        return load(...args);
      };
      h.queuedTurnIds = ['queued-turn'];
      h.flow.watchQueuedTurns('conversation', ['queued-turn']);
      h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn' }];
      await h.flow[action]('conversation');
      resolve(snapshot);
      await settle();
      expect(h.audited).toHaveLength(0);
      expect(h.flowFailures).toHaveLength(0);
      if (action === 'pause') {
        expect(h.goal?.status).toBe('paused');
        await h.flow.resume('conversation');
        await settle();
        expect(h.audited).toEqual(['queued-turn']);
      } else expect(h.goal).toBeNull();
    });
  }

  it('rechecks the resumed queue when an older admission releases its lock', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    const snapshot = h.goal;
    const load = h.repository.loadCurrentGoal;
    let resolve!: (goal: PersistedConversationGoalRecord | null) => void;
    const reading = new Promise<PersistedConversationGoalRecord | null>((done) => { resolve = done; });
    let first = true;
    h.repository.loadCurrentGoal = (...args) => {
      if (first) { first = false; return reading; }
      return load(...args);
    };
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn' }];
    await h.flow.pause('conversation');
    await h.flow.resume('conversation');
    resolve(snapshot);
    await settle();
    expect(h.audited).toEqual(['queued-turn']);
    expect(h.sent).toHaveLength(0);
  });

  it('does not let an old applied audit artifact failure stop newer work', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    let resolve!: (result: GoalAuditResult) => void;
    const result = new Promise<GoalAuditResult>((done) => { resolve = done; });
    h.ports.audit = () => ({ runId: 'old-run', cancel: () => true, result });
    h.ports.saveArtifact = async () => { throw new Error('disk unavailable'); };
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    await h.flow.reserveUserTurn('conversation');
    // The old native verdict committed before cancellation, but its IPC reply is delayed.
    // A newer user turn has since finished and received its own continue verdict.
    h.goal = { ...h.goal!, revision: h.goal!.revision + 3, status: 'continuation_pending' };
    resolve({ status: 'applied', runId: 'old-run', verdict: verdict('continue') });
    await settle();
    expect(h.artifactFailures).toHaveLength(1);
    expect(h.goal?.status).toBe('continuation_pending');
    expect(h.sent).toHaveLength(0);
    h.flow.releaseUserTurn('conversation');
  });


  it('retries Pause when a verdict wins the native CAS', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    const update = h.repository.updateGoalStatus;
    let raced = false;
    h.repository.updateGoalStatus = async (...args) => {
      if (!raced) {
        raced = true;
        h.goal = { ...h.goal!, revision: h.goal!.revision + 1, status: 'continuation_pending' };
        return 'stale';
      }
      return update(...args);
    };
    await h.flow.pause('conversation');
    expect(h.goal?.status).toBe('paused');
  });

  it('reports repeated Pause conflicts after a bounded number of attempts', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    let calls = 0;
    h.repository.updateGoalStatus = async () => { calls += 1; return 'stale'; };
    await expect(h.flow.pause('conversation')).rejects.toThrow('Retry Pause');
    expect(calls).toBe(3);
  });

  it('retains an accepted queued response when Resume loses its status CAS', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    await h.flow.pause('conversation');
    h.queuedTurnIds = [];
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn' }];
    const update = h.repository.updateGoalStatus;
    let raced = false;
    h.repository.updateGoalStatus = async (...args) => {
      if (!raced) {
        raced = true;
        h.goal = { ...h.goal!, revision: h.goal!.revision + 1 };
        return 'stale';
      }
      return update(...args);
    };
    await h.flow.resume('conversation');
    expect(h.audited).toHaveLength(0);
    await h.flow.resume('conversation');
    await settle();
    expect(h.audited).toEqual(['queued-turn']);
    expect(h.sent).toHaveLength(0);
  });


  it('does not attach an in-flight queued admission to a replacement goal', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    const snapshot = h.goal!;
    const load = h.repository.loadCurrentGoal;
    let resolve!: (goal: PersistedConversationGoalRecord | null) => void;
    const reading = new Promise<PersistedConversationGoalRecord | null>((done) => { resolve = done; });
    let first = true;
    h.repository.loadCurrentGoal = (...args) => {
      if (first) { first = false; return reading; }
      return load(...args);
    };
    h.repository.replaceGoal = async () => {
      h.goal = { ...initialGoal(), goalId: 'replacement', status: 'active_ready' };
      return h.goal;
    };
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn' }];
    await h.flow.activate('conversation', 'New objective', 'provider', 'model', null, snapshot);
    resolve(snapshot);
    await settle();
    expect(h.goal?.goalId).toBe('replacement');
    expect(h.goal?.status).toBe('active_ready');
    expect(h.audited).toHaveLength(0);
    expect(h.flowFailures).toHaveLength(0);
  });

  it('retains an attempted queued turn before its messages arrive', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'continuation_pending' };
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.attemptedTurnIds = ['queued-turn'];
    h.queuedTurnIds = [];
    h.notify();
    await settle();
    expect(h.goal?.status).toBe('continuation_pending');
    expect(h.audited).toHaveLength(0);
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn' }];
    h.attemptedTurnIds = [];
    await settle();
    expect(h.audited).toEqual(['queued-turn']);
    expect(h.sent).toHaveLength(0);
  });


  it('reports a write failure while recording a queued turn with no assistant response', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'continuation_pending' };
    const update = h.repository.updateGoalStatus;
    h.repository.updateGoalStatus = async (...args) => {
      if (args[1] === 'error') throw new Error('error write unavailable');
      return update(...args);
    };
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.messages = [{ ...assistant, id: 'queued-user', role: 'user', turn_id: 'queued-turn' }];
    h.queuedTurnIds = [];
    await settle();
    expect(h.flowFailures).toEqual(['error write unavailable']);
    expect(h.flowRetries).toHaveLength(1);
    expect(h.audited).toHaveLength(0);
  });


  it('does not claim an already audited queued turn again after Pause and Resume', async () => {
    let resolve!: (value: GoalAuditResult) => void;
    const pending = new Promise<GoalAuditResult>((done) => { resolve = done; });
    const h = harness(pending);
    h.goal = { ...initialGoal(), status: 'continuation_pending' };
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn' }];
    h.queuedTurnIds = [];
    await settle();
    expect(h.audited).toEqual(['queued-turn']);
    await h.flow.pause('conversation');
    await h.flow.resume('conversation');
    await settle();
    expect(h.audited).toEqual(['queued-turn']);
    expect(h.sent).toHaveLength(1);
    expect(h.goal?.status).toBe('executor_running');
    resolve({ status: 'cancelled', runId: 'run', reason: 'parent_cancelled' });
    await settle();
    expect(h.audited).toEqual(['queued-turn']);
    h.flow.cancel('conversation');
  });

  it('pauses a continuation committed before restart so Resume can send the next turn', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'continuation_pending', latestVerdict: verdict('continue') };
    await h.flow.hydrate('conversation');
    expect(h.goal?.status).toBe('paused');
    expect(h.sent).toHaveLength(0);
    await h.flow.resume('conversation');
    expect(h.sent).toHaveLength(1);
    expect(h.goal?.status).toBe('executor_running');
    h.flow.cancel('conversation');
  });


  it('keeps a queued response when Pause interrupts review preparation before dispatch', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'continuation_pending' };
    const load = h.repository.loadCurrentGoal;
    let runningReads = 0;
    let releaseRead!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRead = resolve; });
    h.repository.loadCurrentGoal = async (...args) => {
      const current = await load(...args);
      if (current?.status === 'executor_running' && ++runningReads === 2) await blocked;
      return current;
    };
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn' }];
    h.queuedTurnIds = [];
    await settle();
    expect(runningReads).toBe(2);
    expect(h.audited).toEqual([]);
    await h.flow.pause('conversation');
    await h.flow.resume('conversation');
    await settle();
    releaseRead();
    await settle();
    expect(h.audited).toEqual(['queued-turn']);
    expect(h.sent).toEqual([]);
    expect(h.goal?.status).toBe('achieved');
  });

  it('retries Resume after an older automatic admission settles without overriding user priority', async () => {
    let resolveSend!: (value: { status: string; turnId: string; assistantMessageId: string | null }) => void;
    const sending = new Promise<{ status: string; turnId: string; assistantMessageId: string | null }>((resolve) => { resolveSend = resolve; });
    let sendCount = 0;
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') }, () =>
      ++sendCount === 1 ? sending : Promise.resolve({ status: 'sent', turnId: 'next-turn', assistantMessageId: 'next-assistant' }));
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    expect(h.sent).toHaveLength(1);
    await h.flow.pause('conversation');
    await h.flow.resume('conversation');
    const reservation = h.flow.reserveUserTurn('conversation');
    h.runtime = { phase: 'idle' };
    resolveSend({ status: 'sent', turnId: 'old-turn', assistantMessageId: 'old-assistant' });
    await reservation;
    await settle();
    expect(h.sent).toHaveLength(1);
    h.flow.releaseUserTurn('conversation');
    await settle();
    expect(h.sent).toHaveLength(2);
    expect(h.goal?.status).toBe('executor_running');
    h.flow.cancel('conversation');
  });

  it('does not dispatch an old pending continuation for a replacement Goal', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('continue') });
    h.queued = 1;
    h.flow.track('conversation', 'turn', 'assistant', 'goal');
    await settle();
    expect(h.goal?.status).toBe('continuation_pending');
    const load = h.repository.loadCurrentGoal;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    h.repository.loadCurrentGoal = async (...args) => {
      if (first) { first = false; await gate; }
      return load(...args);
    };
    h.queued = 0;
    h.notify();
    h.repository.replaceGoal = async () => {
      h.goal = { ...initialGoal(), goalId: 'replacement', objective: 'New objective', status: 'active_ready' };
      return h.goal;
    };
    await h.flow.activate('conversation', 'New objective', 'provider', 'model', null, h.goal!);
    release();
    await settle();
    h.flow.cancel('conversation');
    expect(h.sent).toHaveLength(0);
  });

  it('retains a readmitted queued turn when older review preparation settles', async () => {
    const h = harness({ status: 'applied', runId: 'run', verdict: verdict('achieved') });
    h.goal = { ...initialGoal(), status: 'continuation_pending' };
    const load = h.repository.loadCurrentGoal;
    let runningReads = 0;
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
    h.repository.loadCurrentGoal = async (...args) => {
      const current = await load(...args);
      if (current?.status === 'executor_running') {
        runningReads++;
        if (runningReads === 2) await oldGate;
      }
      return current;
    };
    h.queuedTurnIds = ['queued-turn'];
    h.flow.watchQueuedTurns('conversation', ['queued-turn']);
    h.messages = [{ ...assistant, id: 'queued-assistant', turn_id: 'queued-turn' }];
    h.queuedTurnIds = [];
    await settle();
    expect(runningReads).toBe(2);
    await h.flow.pause('conversation');
    // Pause reads executor_running twice before committing paused.
    const baseline = runningReads;
    h.repository.loadCurrentGoal = async (...args) => {
      const current = await load(...args);
      if (current?.status === 'executor_running' && ++runningReads === baseline + 2) await newGate;
      return current;
    };
    await h.flow.resume('conversation');
    await settle();
    expect(h.audited).toEqual([]);
    releaseOld();
    await settle();
    await h.flow.pause('conversation');
    await h.flow.resume('conversation');
    releaseNew();
    await settle();
    h.flow.cancel('conversation');
    expect(h.audited).toEqual(['queued-turn']);
    expect(h.sent).toHaveLength(0);
  });

});
