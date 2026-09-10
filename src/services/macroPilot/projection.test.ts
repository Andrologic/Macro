import { PilotStartPreflightRejection } from './startEligibility';
import { toTaskRuntimeId } from '../durableIdentity';
import { pilotTaskId, resolvePilotTask, resolvePilotStartTask } from './taskIdentity';
import { describe, expect, it } from 'bun:test';
import type {
  ChatMessage,
  Conversation,
  PendingToolApproval,
  Project,
  Task,
} from '../../types';
import { assertA1, object, PilotError } from './protocol';
import { PilotKernel } from './kernel';
import commandFixture from '../../../contracts/macro-pilot/v1/fixtures/valid/task-reply-command.json';
import {
  projectDesktopSnapshots,
  toolApprovalSourceKey,
  type DesktopProjectionInput,
} from './projection';

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-alpha',
  name: 'Macro',
  mountName: 'macro',
  path: '/workspace/macro',
  created_at: '2026-01-01T00:00:00.000Z',
  status: 'active',
  gitSetupState: 'ready',
  metadata: {
    description: '',
    tags: [],
    team_members: [],
    api_contracts: [],
    dependencies: [],
  },
  ...overrides,
});

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-alpha',
  plan_id: 'plan-alpha',
  project_id: 'project-alpha',
  title: 'Implement Pilot',
  description: '',
  status: 'Pending',
  dependencies: [],
  estimated_changes: [],
  execution_targets: [{
    projectId: 'project-alpha',
    branchName: 'feature/pilot',
    executionMode: 'git',
    worktreeKey: 'pilot',
  }],
  ...overrides,
});

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'conversation-alpha',
  title: 'Pilot',
  scope_mode: 'Implement',
  task_id: 'task-alpha',
  project_id: 'project-alpha',
  last_message: '',
  message_count: 0,
  updated_at: '2026-01-01T00:00:00.000Z',
  is_unread: false,
  ...overrides,
});

const baseInput = (overrides: Partial<DesktopProjectionInput> = {}): DesktopProjectionInput => ({
  instance: {
    instanceId: 'instance-alpha',
    label: 'Studio Mac',
    connectionState: 'reachable',
  },
  workspace: { workspaceId: 'workspace-alpha', label: 'Macro suite' },
  projects: [project()],
  tasks: [task()],
  conversations: [conversation()],
  messages: [],
  questionnaireDraftsByConversationId: {},
  pendingToolApprovalByConversationId: {},
  runningTaskIds: [],
  ...overrides,
});

const assertAllA1 = (input: ReturnType<typeof projectDesktopSnapshots>): void => {
  const snapshots = input.snapshots;
  [
    snapshots.instance,
    snapshots.workspace,
    ...snapshots.projects,
    ...snapshots.tasks,
    ...snapshots.runs,
    ...snapshots.decisions,
    ...snapshots.toolApprovals,
    ...snapshots.reviews,
  ].forEach(assertA1);
};

describe('projectDesktopSnapshots', () => {
  it('rejects forged run.start commands against the actual blocked projection before dispatch', async () => {
    for (const exclusion of [{ draft: true }, { task_source: 'plan_finalization' as const }, { is_blocked: true }]) {
      const input = baseInput({ tasks: [task(exclusion)] });
      let persisted: string | null = null;
      let executions = 0;
      const kernel = new PilotKernel({
        instanceId: input.instance.instanceId,
        storage: { load: async () => persisted, compareAndSwap: async (previous, next) => {
          if (previous !== persisted) return false;
          persisted = next; return true;
        } },
        project: (previous, now) => {
          const result = projectDesktopSnapshots(input, previous as Parameters<typeof projectDesktopSnapshots>[1], now);
          return { snapshots: result.snapshots.tasks, state: result.state };
        },
        authorize: async () => new Date(Date.now() + 5000).toISOString(),
        execute: async () => { executions++; },
      });
      await kernel.initialize();
      const snapshot = projectDesktopSnapshots(input, undefined, new Date()).snapshots.tasks[0];
      const command = { ...commandFixture, kind: 'run.start', target: snapshot.ref,
        expected_revision: snapshot.revision, payload: { run_id: 'run:forged-start' } };
      const result = await kernel.handle({ transport_version: '1.0', type: 'delivery', exchange_id: 'exchange:forged-start',
        delivery_id: 'delivery:forged-start', actor: command.issued_by, message: command });
      expect(object(object(result.message).error).code).toBe('conflict');
      expect(executions).toBe(0);
      expect(kernel.getKnownRuns()).toEqual([]);
      expect(kernel.indeterminate()).toEqual([]);
      expect(object(JSON.parse(persisted!)).journal).toEqual({});
    }
  });

  it('publishes ineligible starts as blocked and revises them when eligibility changes', () => {
    for (const status of ['Pending', 'Failed'] as const) {
      for (const exclusion of [{ draft: true }, { task_source: 'plan_finalization' as const }, { is_blocked: true }]) {
        const first = projectDesktopSnapshots(baseInput({ tasks: [task({ status })] }), undefined, '2026-02-01T12:00:00Z');
        const blocked = projectDesktopSnapshots(baseInput({ tasks: [task({ status, ...exclusion })] }), first.state, '2026-02-01T12:01:00Z');
        assertAllA1(blocked);
        expect(blocked.snapshots.tasks[0].state).toBe('blocked');
        expect(blocked.snapshots.tasks[0].revision).toBe(first.snapshots.tasks[0].revision + 1);
        const restored = projectDesktopSnapshots(baseInput({ tasks: [task({ status })] }), blocked.state, '2026-02-01T12:02:00Z');
        expect(restored.snapshots.tasks[0].state).toBe(status === 'Pending' ? 'queued' : 'failed');
        expect(restored.snapshots.tasks[0].revision).toBe(blocked.snapshots.tasks[0].revision + 1);
      }
    }
  });

  it('keeps identities, observations, and revisions stable when only observation time changes', () => {
    const first = projectDesktopSnapshots(baseInput(), undefined, '2026-02-01T12:00:00Z');
    const second = projectDesktopSnapshots(baseInput(), first.state, '2026-02-02T12:00:00Z');

    assertAllA1(first);
    assertAllA1(second);
    expect(second.snapshots).toEqual(first.snapshots);
    expect(second.state).toEqual(first.state);

    const changed = projectDesktopSnapshots(baseInput({
      tasks: [task({ title: 'Implement private Pilot' })],
    }), second.state, '2026-02-03T12:00:00Z');
    expect(changed.snapshots.tasks[0]!.revision).toBe(first.snapshots.tasks[0]!.revision + 1);
    expect(changed.snapshots.projects[0]!.revision).toBe(first.snapshots.projects[0]!.revision);
    expect(changed.snapshots.tasks[0]!.observed_at).toBe('2026-02-01T12:00:00.000Z');
  });

  it('uses reply attention without fabricating a questionnaire', () => {
    const input = baseInput({
      tasks: [task({ status: 'AwaitingResponse', conversation_id: 'conversation-alpha' })],
      messages: [{
        id: 'message-assistant',
        task_id: 'task-alpha',
        conversation_id: 'conversation-alpha',
        role: 'assistant',
        content: 'Which branch should I use?',
        timestamp: '2026-02-01T11:59:00Z',
      }],
    });
    const result = projectDesktopSnapshots(input, undefined, '2026-02-01T12:00:00Z');

    assertAllA1(result);
    expect(result.snapshots.tasks[0]).toMatchObject({
      state: 'waiting_reply',
      reply_context: {
        conversation_id: 'conversation-alpha',
        prompt: 'Which branch should I use?',
      },
      projection: { missing: ['run_history'] },
    });
    expect(result.snapshots.decisions).toEqual([]);
  });

  it('projects a historical questionnaire from its real messages with unknown provenance', () => {
    const questionnaireMessage: ChatMessage = {
      id: 'message-questionnaire',
      task_id: 'task-alpha',
      conversation_id: 'conversation-alpha',
      role: 'assistant',
      content: 'Choose a scope.',
      timestamp: '2026-02-01T11:00:00Z',
      questionnaire: {
        questions: [{
          id: 'scope',
          prompt: 'Which scope?',
          choices: ['Small', 'Medium', 'Large'],
          free_text_placeholder: 'Another scope',
        }],
      },
    };
    const response: ChatMessage = {
      id: 'message-response',
      task_id: 'task-alpha',
      conversation_id: 'conversation-alpha',
      role: 'user',
      content: 'Medium',
      timestamp: '2026-02-01T11:01:00Z',
      questionnaire_response_summary: {
        assistantMessageId: questionnaireMessage.id,
        items: [{ id: 'scope', prompt: 'Which scope?', answer: 'Medium' }],
      },
    };
    const first = projectDesktopSnapshots(baseInput({
      tasks: [task({ status: 'Completed' })],
      messages: [questionnaireMessage, response],
    }), undefined, '2026-02-01T12:00:00Z');
    const second = projectDesktopSnapshots(baseInput({
      tasks: [task({ status: 'Completed' })],
      messages: [questionnaireMessage, response],
    }), first.state, '2026-02-02T12:00:00Z');

    assertAllA1(first);
    expect(first.snapshots.decisions[0]).toMatchObject({
      state: 'resolved',
      ref: {
        conversation_id: 'conversation-alpha',
        assistant_message_id: 'message-questionnaire',
      },
      resolution: {
        answers: [{ step_id: 'scope', answer: 'Medium' }],
        resolved_by: { origin: 'unknown' },
      },
    });
    expect((first.snapshots.decisions[0]!.resolution as Record<string, unknown>).resolved_at).toBeUndefined();
    expect(second.snapshots.decisions[0]!.ref).toEqual(first.snapshots.decisions[0]!.ref);
    expect(second.snapshots.decisions[0]!.revision).toBe(first.snapshots.decisions[0]!.revision);
  });

  it('exports only display approval fields and keeps a known run reference', () => {
    const approval: PendingToolApproval = {
      conversationId: 'conversation-alpha',
      assistantMessageId: 'message-approval',
      toolCallId: 'tool-call-alpha',
      toolId: 'terminal_run',
      actionGroup: 'escape',
      riskLevel: 'strict',
      isDestructive: true,
      summary: 'Read /Users/private/project with sk-abcdefghijklmnop',
      detail: 'private detail',
      args: { command: 'cat /Users/private/project/.env' },
      rememberKey: 'secret-key',
      canApproveForConversation: true,
    };
    const approvalKey = toolApprovalSourceKey(approval);
    const result = projectDesktopSnapshots(baseInput({
      tasks: [task({ status: 'AwaitingResponse', conversation_id: 'conversation-alpha' })],
      pendingToolApprovalByConversationId: { 'conversation-alpha': approval },
      knownRuns: [{
        taskId: 'task-alpha',
        runId: 'run-task-alpha',
        startedAt: '2026-02-01T11:00:00Z',
      }],
      toolApprovalObservedAtBySourceKey: {
        [approvalKey]: '2026-02-01T12:00:00Z',
      },
    }), undefined, '2026-02-01T12:00:00Z');

    assertAllA1(result);
    const wire = JSON.stringify(result.snapshots.toolApprovals[0]);
    expect(result.snapshots.tasks[0]!.state).toBe('waiting_tool_approval');
    expect(result.snapshots.toolApprovals[0]).toMatchObject({
      ref: { task_id: 'task-alpha', run_id: 'run-task-alpha' },
      state: 'pending',
      allowed_scopes: ['once', 'conversation'],
    });
    expect(wire).not.toContain('/Users/');
    expect(wire).not.toContain('sk-abcdefghijklmnop');
    expect(wire).not.toContain('private detail');
    expect(wire).not.toContain('rememberKey');

    const absent = projectDesktopSnapshots(baseInput(), result.state, '2026-02-02T12:00:00Z');
    expect(absent.snapshots.toolApprovals).toEqual([]);
    expect(absent.state.resources[`approval:${approvalKey}`]).toBeDefined();

    const resolved = projectDesktopSnapshots(baseInput({
      toolApprovalResolutionsBySourceKey: {
        [approvalKey]: {
          verdict: 'deny',
          reason: 'Keep this file.',
          resolvedAt: '2026-02-02T12:01:00Z',
        },
      },
    }), absent.state, '2026-02-02T12:02:00Z');
    assertAllA1(resolved);
    expect(resolved.snapshots.toolApprovals[0]).toMatchObject({
      state: 'resolved',
      resolution: {
        verdict: 'deny',
        reason: 'Keep this file.',
        resolved_by: { origin: 'local' },
        resolved_at: '2026-02-02T12:01:00.000Z',
      },
    });
    expect(resolved.snapshots.toolApprovals[0]!.revision)
      .toBe(result.snapshots.toolApprovals[0]!.revision + 1);
  });

  it('does not attach an old questionnaire to a run launched later for the same task', () => {
    const oldQuestionnaire: ChatMessage = {
      id: 'message-old-questionnaire',
      task_id: 'task-alpha',
      conversation_id: 'conversation-alpha',
      role: 'assistant',
      content: 'Choose a scope.',
      timestamp: '2026-02-01T09:00:00Z',
      questionnaire: {
        questions: [{
          id: 'scope',
          prompt: 'Which scope?',
          choices: ['Small', 'Medium', 'Large'],
        }],
      },
    };
    const input = baseInput({
      messages: [oldQuestionnaire],
      knownRuns: [{
        taskId: 'task-alpha',
        runId: 'run-new-alpha',
        startedAt: '2026-02-01T10:00:00Z',
      }],
    });
    const first = projectDesktopSnapshots(input, undefined, '2026-02-01T10:01:00Z');
    const second = projectDesktopSnapshots(baseInput({
      messages: [oldQuestionnaire],
      knownRuns: [{
        taskId: 'task-alpha',
        runId: 'run-newer-alpha',
        startedAt: '2026-02-02T10:00:00Z',
      }],
    }), first.state, '2026-02-02T10:01:00Z');

    assertAllA1(first);
    assertAllA1(second);
    expect(first.snapshots.decisions[0]!.ref).not.toHaveProperty('run_id');
    expect(second.snapshots.decisions[0]!.ref).not.toHaveProperty('run_id');
    expect(second.state.resources['decision:conversation-alpha:message-old-questionnaire']?.boundRunId)
      .toBeNull();
  });

  it('uses an injective approval source key when identifiers contain separators', () => {
    expect(toolApprovalSourceKey({
      conversationId: 'conversation:a',
      assistantMessageId: 'message',
      toolCallId: 'call',
    })).not.toBe(toolApprovalSourceKey({
      conversationId: 'conversation',
      assistantMessageId: 'a:message',
      toolCallId: 'call',
    }));
  });

  it('refuses a task whose execution mode cannot be projected honestly', () => {
    const input = baseInput({
      projects: [project({ gitSetupState: 'unknown' })],
      tasks: [task({ execution_targets: undefined })],
    });

    expect(() => projectDesktopSnapshots(input, undefined, '2026-02-01T12:00:00Z'))
      .toThrow(PilotError);
  });
});


describe('branch-qualified Pilot task identities', () => {
  it('projects distinct branches and resolves a wire action to the exact local task', () => {
    const ids = ['feature/one', 'feature/two'].map(branchName => toTaskRuntimeId({ branchName, planId: 'plan-alpha', nodeId: 'node-alpha' }));
    const tasks = ids.map(id => task({ id, status: 'AwaitingResponse', conversation_id: `conversation-${ids.indexOf(id)}` }));
    const input = baseInput({ tasks, conversations: ids.map((id, index) => conversation({ id: `conversation-${index}`, task_id: id })) });
    const result = projectDesktopSnapshots(input, null, '2026-02-01T12:00:00Z');
    assertAllA1(result);
    const refs = result.snapshots.tasks.map(snapshot => snapshot.ref.task_id);
    expect(new Set(refs).size).toBe(2);
    refs.forEach((ref, index) => expect(resolvePilotTask(tasks, ref)).toBe(tasks[index]));
    expect(input.tasks.map(task => task.id)).toEqual(ids);
    expect(pilotTaskId('task-alpha')).toBe('task-alpha');
    expect(pilotTaskId('task:v1:' + 'encoded%2F'.repeat(100))).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
    expect(projectDesktopSnapshots(input, result.state, '2026-02-01T12:01:00Z').snapshots.tasks.map(t => t.ref)).toEqual(result.snapshots.tasks.map(t => t.ref));
  });

  it('refuses a literal ID that collides with an encoded ID', () => {
    const local = 'task:v1:feature%2Fone:plan:node';
    const tasks = [task({ id: local }), task({ id: pilotTaskId(local) })];
    expect(() => resolvePilotTask(tasks, pilotTaskId(local))).toThrow('invalid_reference');
    expect(() => resolvePilotTask(tasks, 'unknown-task')).toThrow('invalid_reference');
    expect(() => resolvePilotStartTask(tasks, pilotTaskId(local))).toThrow(PilotStartPreflightRejection);
    expect(() => resolvePilotStartTask([], 'missing-task')).toThrow(PilotStartPreflightRejection);
    expect(() => projectDesktopSnapshots(baseInput({ tasks }), null, new Date())).toThrow('validation_failed');
  });
});
