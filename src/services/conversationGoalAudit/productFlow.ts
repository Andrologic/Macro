import type { ChatMessage, ConversationGoalRecord, ReasoningEffort } from '../../types';
import type { ConversationGoalAudit } from '../../types/generated/ipc';
import { ConversationGoalProductRepository, type PersistedConversationGoalRecord } from './productRepository';
import type { GoalAuditHandle, GoalAuditResult } from './types';

const newId = (): string => crypto.randomUUID();
const MAX_FEEDBACK_LENGTH = 2_000;

export interface GoalProductFlowPorts {
  repository: Pick<ConversationGoalProductRepository, 'loadCurrentGoal' | 'activateGoal' | 'replaceGoal' | 'updateGoalStatus' | 'stopGoal'>;
  readRuntime(conversationId: string): { phase: string; turnId?: string | null };
  readMessages(conversationId: string): ChatMessage[];
  readQueuedCount(conversationId: string): number;
  readQueuedTurnIds(conversationId: string): string[];
  readQueuedAttemptedTurnIds(conversationId: string): string[];
  sendContinuation(conversationId: string, content: string): Promise<{ status: string; turnId: string; assistantMessageId: string | null }>;
  audit(goal: PersistedConversationGoalRecord, turnId: string, summary: string): GoalAuditHandle;
  saveArtifact(input: { auditId: string; runId: string; goal: PersistedConversationGoalRecord; turnId: string; messageId: string; result: GoalAuditResult }): Promise<void>;
  listRecoverable(): Promise<ConversationGoalAudit[]>;
  subscribe(listener: () => void): () => void;
  publish(conversationId: string, goal: PersistedConversationGoalRecord | null): void;
  onArtifactFailure(message: string): void;
  onFlowFailure(message: string): void;
}

interface TrackedTurn { turnId: string; assistantMessageId: string; goalId: string; started: boolean }

/** Native revisions own the cycle; this service only schedules work after a persisted assistant turn. */
export class ConversationGoalProductFlow {
  private readonly ports: GoalProductFlowPorts;
  private readonly tracked = new Map<string, TrackedTurn>();
  private readonly audits = new Map<string, GoalAuditHandle>();
  private readonly generations = new Map<string, number>();
  private readonly admissions = new Set<string>();
  private readonly userAdmissions = new Map<string, number>();
  private readonly admissionWaiters = new Map<string, Array<() => void>>();
  private readonly continuationPending = new Set<string>();
  private readonly queuedTurns = new Map<string, Set<string>>();
  private readonly queuedAdmissions = new Set<string>();
  private readonly suspended = new Set<string>();
  private readonly lastContinueEvidence = new Map<string, { goalId: string; fingerprint: string }>();
  private unsubscribe: (() => void) | null = null;

  constructor(ports: GoalProductFlowPorts) { this.ports = ports; }

  private publish(conversationId: string, goal: PersistedConversationGoalRecord | null): void {
    this.ports.publish(conversationId, goal);
  }

  private bump(conversationId: string): number {
    const generation = (this.generations.get(conversationId) ?? 0) + 1;
    this.generations.set(conversationId, generation);
    return generation;
  }

  private async refresh(conversationId: string): Promise<PersistedConversationGoalRecord | null> {
    const generation = this.generations.get(conversationId) ?? 0;
    const goal = await this.ports.repository.loadCurrentGoal(conversationId);
    if (generation === (this.generations.get(conversationId) ?? 0)) this.publish(conversationId, goal);
    return goal;
  }

  loadCurrent(conversationId: string): Promise<PersistedConversationGoalRecord | null> {
    return this.ports.repository.loadCurrentGoal(conversationId);
  }

  async hydrate(conversationId: string): Promise<void> {
    const goal = await this.refresh(conversationId);
    if (!goal) return;
    if (this.queuedTurns.get(conversationId)?.size &&
        ['executor_running', 'audit_pending', 'auditing'].includes(goal.status) &&
        !this.tracked.has(conversationId) && !this.audits.has(conversationId)) {
      await this.status(conversationId, 'active_ready', null, goal);
      return;
    }
    if (['executor_running', 'audit_pending', 'auditing'].includes(goal.status) &&
        !this.tracked.has(conversationId) && !this.audits.has(conversationId) && !this.admissions.has(conversationId)) {
      const audits = await this.ports.listRecoverable();
      const latest = await this.ports.repository.loadCurrentGoal(conversationId);
      if (!latest || latest.goalId !== goal.goalId || latest.revision !== goal.revision ||
          this.tracked.has(conversationId) || this.audits.has(conversationId)) return;
      const matching = audits.find((audit: ConversationGoalAudit) => audit.conversationId === conversationId && audit.goalId === goal.goalId);
      const reason = matching ? 'The previous goal review was interrupted. Resume to start a new agent turn.' : 'The previous agent turn was interrupted. Resume to continue.';
      await this.status(conversationId, 'paused', reason, goal);
    }
  }

  async activate(conversationId: string, objective: string, providerId: string | null, modelId: string | null, reasoningEffort: ReasoningEffort | null, replacement?: ConversationGoalRecord): Promise<PersistedConversationGoalRecord> {
    const input = { conversationId, goalId: newId(), objective: objective.trim(), successCriteria: [objective.trim().replace(/\s+/g, ' ')], providerId, modelId, reasoningEffort };
    const goal = replacement
      ? await this.ports.repository.replaceGoal({ ...input, replaceGoalId: replacement.goalId, replaceRevision: replacement.revision })
      : await this.ports.repository.activateGoal(input);
    this.cancel(conversationId);
    this.lastContinueEvidence.delete(conversationId);
    this.bump(conversationId);
    this.publish(conversationId, goal);
    return goal;
  }

  async status(conversationId: string, status: 'active_ready' | 'executor_running' | 'audit_pending' | 'paused' | 'error', reason: string | null = null, expected?: Pick<ConversationGoalRecord, 'goalId' | 'revision'>): Promise<PersistedConversationGoalRecord | null> {
    const goal = await this.ports.repository.loadCurrentGoal(conversationId);
    if (!goal || goal.status === 'achieved' ||
        (expected && (goal.goalId !== expected.goalId || goal.revision !== expected.revision))) {
      await this.refresh(conversationId);
      return null;
    }
    if (status === 'executor_running' && !['active_ready', 'continuation_pending', 'awaiting_user'].includes(goal.status)) return null;
    const outcome = await this.ports.repository.updateGoalStatus(goal, status, reason);
    if (outcome !== 'applied') { await this.refresh(conversationId); return null; }
    this.bump(conversationId);
    return this.refresh(conversationId);
  }

  async stop(conversationId: string): Promise<void> {
    this.cancel(conversationId);
    this.lastContinueEvidence.delete(conversationId);
    const goal = await this.ports.repository.loadCurrentGoal(conversationId);
    if (!goal) { this.publish(conversationId, null); return; }
    const outcome = await this.ports.repository.stopGoal(goal);
    if (outcome === 'applied') this.bump(conversationId);
    await this.refresh(conversationId);
  }

  async pause(conversationId: string): Promise<void> {
    const queued = [...this.queuedTurns.get(conversationId) ?? []];
    this.cancel(conversationId);
    this.suspended.add(conversationId);
    if (queued.length) this.queuedTurns.set(conversationId, new Set(queued));
    await this.status(conversationId, 'paused');
  }

  async resume(conversationId: string): Promise<void> {
    const goal = await this.ports.repository.loadCurrentGoal(conversationId);
    if (!goal || !['paused', 'error', 'awaiting_user', 'active_ready'].includes(goal.status)) return;
    const queued = [...this.queuedTurns.get(conversationId) ?? []];
    this.cancel(conversationId);
    this.lastContinueEvidence.delete(conversationId);
    const ready = goal.status === 'active_ready' ? goal : await this.status(conversationId, 'active_ready', null, goal);
    if (ready) {
      this.suspended.delete(conversationId);
      if (queued.length) this.queuedTurns.set(conversationId, new Set(queued));
      this.reconcileQueuedTurns(conversationId);
      if (this.queuedTurns.get(conversationId)?.size) {
        this.unsubscribe ??= this.ports.subscribe(() => void this.check());
        void this.check();
      }
      if (this.queuedTurns.get(conversationId)?.size) return;
      await this.startExecutorTurn(conversationId, ready,
        `Continue the current goal: ${ready.objective}\nReview the current conversation and work before acting. Ask the user if their input is needed.`);
    }
  }

  /** Give a user-initiated send priority over an automatic continuation. */
  async reserveUserTurn(conversationId: string): Promise<PersistedConversationGoalRecord | null> {
    this.userAdmissions.set(conversationId, (this.userAdmissions.get(conversationId) ?? 0) + 1);
    this.bump(conversationId);
    try {
      while (this.admissions.has(conversationId)) {
        await new Promise<void>((resolve) => {
          const waiters = this.admissionWaiters.get(conversationId) ?? [];
          waiters.push(resolve);
          this.admissionWaiters.set(conversationId, waiters);
        });
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await this.ports.repository.loadCurrentGoal(conversationId);
        if (!current || ['paused', 'error', 'achieved'].includes(current.status)) return current;
        if (['audit_pending', 'auditing'].includes(current.status)) {
          this.bump(conversationId);
          this.audits.get(conversationId)?.cancel();
          this.audits.delete(conversationId);
          const ready = await this.status(conversationId, 'active_ready', null, current);
          if (ready) return ready;
          continue;
        }
        return current;
      }
      throw new Error('Goal changed repeatedly while admitting a user turn.');
    } catch (error) {
      this.releaseUserTurn(conversationId);
      throw error;
    }
  }

  releaseUserTurn(conversationId: string): void {
    const count = this.userAdmissions.get(conversationId) ?? 0;
    if (count <= 1) this.userAdmissions.delete(conversationId);
    else this.userAdmissions.set(conversationId, count - 1);
    void this.check();
  }

  /** Serialize admission so competing callers cannot start two automatic turns. */
  private async startExecutorTurn(conversationId: string, expected: PersistedConversationGoalRecord, content: string): Promise<void> {
    if (this.admissions.has(conversationId)) return;
    this.admissions.add(conversationId);
    const generation = this.generations.get(conversationId) ?? 0;
    try {
      const current = await this.ports.repository.loadCurrentGoal(conversationId);
      if (!current || current.goalId !== expected.goalId || current.revision !== expected.revision ||
          !['active_ready', 'continuation_pending'].includes(current.status)) return;
      if (this.userAdmissions.has(conversationId) || this.queuedTurns.get(conversationId)?.size ||
          this.ports.readQueuedCount(conversationId) > 0 || this.ports.readRuntime(conversationId).phase !== 'idle') {
        this.continuationPending.add(conversationId);
        this.unsubscribe ??= this.ports.subscribe(() => void this.check());
        return;
      }
      this.continuationPending.delete(conversationId);
      const running = await this.status(conversationId, 'executor_running', null, current);
      if (!running || running.status !== 'executor_running') return;
      if ((this.generations.get(conversationId) ?? 0) !== generation + 1 ||
          this.userAdmissions.has(conversationId) || this.queuedTurns.get(conversationId)?.size ||
          this.ports.readQueuedCount(conversationId) > 0 ||
          this.ports.readRuntime(conversationId).phase !== 'idle') {
        await this.status(conversationId, 'active_ready', null, running);
        this.continuationPending.add(conversationId);
        this.unsubscribe ??= this.ports.subscribe(() => void this.check());
        return;
      }
      const sent = await this.ports.sendContinuation(conversationId, content);
      const latest = await this.ports.repository.loadCurrentGoal(conversationId);
      if (!latest || latest.goalId !== running.goalId || latest.revision !== running.revision || latest.status !== 'executor_running') return;
      if (sent.status === 'sent' && sent.assistantMessageId) this.track(conversationId, sent.turnId, sent.assistantMessageId, running.goalId);
      else await this.status(conversationId, 'paused', 'Automatic continuation did not start.', running);
    } catch (error) {
      const current = await this.ports.repository.loadCurrentGoal(conversationId).catch(() => null);
      if (current?.goalId === expected.goalId && current.status === 'executor_running') {
        await this.status(conversationId, 'error', error instanceof Error ? error.message : 'Goal continuation failed.', current).catch(() => undefined);
      }
    } finally {
      this.admissions.delete(conversationId);
      this.admissionWaiters.get(conversationId)?.forEach((resolve) => resolve());
      this.admissionWaiters.delete(conversationId);
    }
  }

  track(conversationId: string, turnId: string, assistantMessageId: string, goalId: string): void {
    if (!turnId || !assistantMessageId) return;
    this.tracked.set(conversationId, { turnId, assistantMessageId, goalId, started: false });
    this.unsubscribe ??= this.ports.subscribe(() => void this.check());
    void this.check();
  }

  watchQueuedTurns(conversationId: string, turnIds: string[]): void {
    if (!turnIds.length) return;
    const pending = this.queuedTurns.get(conversationId) ?? new Set<string>();
    turnIds.forEach((id) => pending.add(id));
    this.queuedTurns.set(conversationId, pending);
    this.bump(conversationId);
    this.unsubscribe ??= this.ports.subscribe(() => void this.check());
    void this.check();
  }

  reconcileQueuedTurns(conversationId: string): void {
    this.watchQueuedTurns(conversationId, this.ports.readQueuedTurnIds(conversationId));
  }

  cancel(conversationId: string): void {
    this.bump(conversationId);
    this.continuationPending.delete(conversationId);
    this.queuedTurns.delete(conversationId);
    this.suspended.delete(conversationId);
    this.tracked.delete(conversationId);
    this.audits.get(conversationId)?.cancel();
    this.audits.delete(conversationId);
    this.releaseSubscriptionIfIdle();
  }

  private releaseSubscriptionIfIdle(): void {
    if (this.tracked.size === 0 && this.continuationPending.size === 0 && this.queuedTurns.size === 0 && this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
  }

  private async admitQueuedTurn(conversationId: string, turnId: string): Promise<void> {
    try {
      if (this.suspended.has(conversationId)) return;
      let goal = await this.ports.repository.loadCurrentGoal(conversationId);
      if (!goal || ['paused', 'error', 'achieved'].includes(goal.status)) {
        this.queuedTurns.get(conversationId)?.delete(turnId);
        return;
      }
      if (['audit_pending', 'auditing'].includes(goal.status)) {
        this.bump(conversationId);
        this.audits.get(conversationId)?.cancel();
        this.audits.delete(conversationId);
        goal = await this.status(conversationId, 'active_ready', null, goal);
      } else if (goal.status === 'executor_running' && this.tracked.get(conversationId)?.turnId !== turnId) {
        this.tracked.delete(conversationId);
        this.bump(conversationId);
        goal = await this.status(conversationId, 'active_ready', null, goal);
      }
      if (!goal) return;
      if (goal.status !== 'executor_running') goal = await this.status(conversationId, 'executor_running', null, goal);
      if (!goal) return;
      const messages = this.ports.readMessages(conversationId);
      const assistant = messages.find((item) => item.role === 'assistant' && item.turn_id === turnId);
      if (assistant) {
        this.queuedTurns.get(conversationId)?.delete(turnId);
        if (this.queuedTurns.get(conversationId)?.size === 0) this.queuedTurns.delete(conversationId);
        this.track(conversationId, turnId, assistant.id, goal.goalId);
      } else if (this.ports.readRuntime(conversationId).phase === 'idle' &&
          !this.ports.readQueuedTurnIds(conversationId).includes(turnId) &&
          !this.ports.readQueuedAttemptedTurnIds(conversationId).includes(turnId) &&
          messages.some((item) => item.role === 'user' && item.turn_id === turnId)) {
        this.queuedTurns.get(conversationId)?.delete(turnId);
        if (this.queuedTurns.get(conversationId)?.size === 0) this.queuedTurns.delete(conversationId);
        await this.status(conversationId, 'error', 'The queued executor turn did not return a saved assistant response.', goal);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.suspended.add(conversationId);
      const current = await this.ports.repository.loadCurrentGoal(conversationId).catch(() => null);
      if (current && !['paused', 'achieved'].includes(current.status)) {
        await this.status(conversationId, 'error', message, current).catch(() => undefined);
      }
      this.ports.onFlowFailure(message);
    } finally {
      this.queuedAdmissions.delete(conversationId);
      this.releaseSubscriptionIfIdle();
    }
  }

  private async check(): Promise<void> {
    for (const [conversationId, turnIds] of this.queuedTurns) {
      if (this.suspended.has(conversationId)) continue;
      const queued = new Set(this.ports.readQueuedTurnIds(conversationId));
      const attempted = new Set(this.ports.readQueuedAttemptedTurnIds(conversationId));
      const messages = this.ports.readMessages(conversationId);
      const runtime = this.ports.readRuntime(conversationId);
      for (const turnId of turnIds) {
        const hasMessage = messages.some((item) => item.turn_id === turnId);
        if (!queued.has(turnId) && !attempted.has(turnId) && !hasMessage) {
          turnIds.delete(turnId);
          continue;
        }
        if (!messages.some((item) => item.role === 'assistant' && item.turn_id === turnId) &&
            !(messages.some((item) => item.role === 'user' && item.turn_id === turnId) &&
              !queued.has(turnId) && !attempted.has(turnId) && runtime.phase === 'idle')) continue;
        if (this.queuedAdmissions.has(conversationId)) break;
        this.queuedAdmissions.add(conversationId);
        void this.admitQueuedTurn(conversationId, turnId);
        break;
      }
      if (turnIds.size === 0) this.queuedTurns.delete(conversationId);
    }
    for (const conversationId of this.continuationPending) {
      if (this.userAdmissions.has(conversationId) || this.queuedTurns.get(conversationId)?.size ||
          this.ports.readQueuedCount(conversationId) || this.ports.readRuntime(conversationId).phase !== 'idle') continue;
      const current = await this.ports.repository.loadCurrentGoal(conversationId);
      if (!current || !['active_ready', 'continuation_pending'].includes(current.status)) { this.continuationPending.delete(conversationId); continue; }
      const feedback = current.latestVerdict?.feedback || current.latestVerdict?.summary || current.objective;
      await this.startExecutorTurn(conversationId, current, `Continue the current goal. Independent review: ${feedback.slice(0, MAX_FEEDBACK_LENGTH)}`);
    }
    for (const [conversationId, turn] of this.tracked) {
      if (turn.started) continue;
      const runtime = this.ports.readRuntime(conversationId);
      if (runtime.phase !== 'idle' && runtime.phase !== 'error') continue;
      const message = this.ports.readMessages(conversationId).find((item) => item.id === turn.assistantMessageId && item.turn_id === turn.turnId && item.role === 'assistant');
      if (runtime.phase === 'idle' && runtime.turnId === turn.turnId) continue;
      if (runtime.phase === 'error' || !message || message.persistence_state ||
          message.completion_reason === 'incomplete' ||
          !message.content.trim() && !message.tool_traces?.length) {
        turn.started = true;
        if (this.tracked.get(conversationId) === turn) this.tracked.delete(conversationId);
        this.releaseSubscriptionIfIdle();
        const current = await this.ports.repository.loadCurrentGoal(conversationId);
        if (current?.goalId === turn.goalId && current.status === 'executor_running') {
          await this.status(conversationId, 'error', 'The executor turn did not finish with a saved assistant response.', current);
        }
        continue;
      }
      turn.started = true;
      void this.review(conversationId, turn, message);
    }
  }

  private async review(conversationId: string, turn: TrackedTurn, message: ChatMessage): Promise<void> {
    const generation = this.generations.get(conversationId) ?? 0;
    let auditId: string | null = null;
    let auditHandle: GoalAuditHandle | null = null;
    let ownGeneration = generation;
    try {
      const current = await this.ports.repository.loadCurrentGoal(conversationId);
      if (!current || current.goalId !== turn.goalId || current.status !== 'executor_running' || generation !== (this.generations.get(conversationId) ?? 0)) return;
      const pending = await this.status(conversationId, 'audit_pending', null, current);
      if (!pending || pending.goalId !== turn.goalId || pending.status !== 'audit_pending') return;
      ownGeneration = this.generations.get(conversationId) ?? 0;
      const audit = this.ports.audit(pending, turn.turnId, message.content.slice(0, 4_000) || 'The executor completed a tool turn.');
      auditHandle = audit;
      auditId = (audit as GoalAuditHandle & { auditId?: string }).auditId ?? audit.runId;
      this.audits.set(conversationId, audit);
      const result = await audit.result;
      const latest = await this.refresh(conversationId);
      if (result.runId && auditId && latest?.goalId === turn.goalId) {
        try {
          await this.ports.saveArtifact({ auditId, runId: result.runId, goal: pending, turnId: turn.turnId, messageId: message.id, result });
        } catch (error) {
          if (result.status === 'applied') {
            const message = `Goal review artifact was not saved: ${error instanceof Error ? error.message : String(error)}`;
            this.ports.onArtifactFailure(message);
            if (latest.status === 'continuation_pending') await this.status(conversationId, 'error', message, latest);
          }
          return;
        }
      }
      if (!latest || latest.goalId !== turn.goalId || ['paused', 'achieved', 'awaiting_user'].includes(latest.status) ||
          ownGeneration !== (this.generations.get(conversationId) ?? 0)) return;
      if (result.status !== 'applied') {
        if (result.status === 'stale' || result.status === 'cancelled') return;
        await this.status(conversationId, 'error', result.status === 'failed' ? `${result.error.code}: ${result.error.message}` : 'Goal review timed out. Resume to try another agent turn.', latest);
        return;
      }
      if (result.verdict.verdict === 'cannot_progress') return;
      if (result.verdict.verdict !== 'continue' || latest.status !== 'continuation_pending') return;
      const fingerprint = JSON.stringify({ criteria: result.verdict.criteria, feedback: result.verdict.feedback, summary: result.verdict.summary });
      const prior = this.lastContinueEvidence.get(conversationId);
      if (prior?.goalId === turn.goalId && prior.fingerprint === fingerprint) {
        await this.status(conversationId, 'paused', 'Two reviews found the same remaining work without new evidence. Resume after changing the approach.', latest);
        return;
      }
      this.lastContinueEvidence.set(conversationId, { goalId: turn.goalId, fingerprint });
      const feedback = result.verdict.feedback.slice(0, MAX_FEEDBACK_LENGTH);
      await this.startExecutorTurn(conversationId, latest, `Continue the current goal. Independent review: ${feedback || result.verdict.summary.slice(0, MAX_FEEDBACK_LENGTH)}\nCheck the current objective and stop if user input is needed.`);
    } catch (error) {
      const current = await this.ports.repository.loadCurrentGoal(conversationId).catch(() => null);
      if (current?.goalId === turn.goalId && current.status !== 'achieved' && current.status !== 'paused' &&
          ownGeneration === (this.generations.get(conversationId) ?? 0)) {
        await this.status(conversationId, 'error', error instanceof Error ? error.message : 'Goal review failed.', current).catch(() => undefined);
      }
    } finally {
      if (this.tracked.get(conversationId) === turn) this.tracked.delete(conversationId);
      if (auditHandle && this.audits.get(conversationId) === auditHandle) this.audits.delete(conversationId);
      this.releaseSubscriptionIfIdle();
    }
  }
}
