import { expect, test } from 'bun:test';
import { PilotKernel } from './kernel';
import { assertA1 } from './protocol';
import { PilotRuntime } from './runtime';
import { desktopStorePorts } from '../../composition/macroPilotDesktop';
import { workflowTaskFixture } from '../workflowAgentTasks.fixtures';
import { projectWorkflowAgentTasks } from '../workflowAgentTasks';
import { pilotTaskId } from './taskIdentity';
import { pilotStartRejection } from './startEligibility';
import type { Command, Resource } from './protocol';

test('runtime projection and action resolution exclude real AgSDL tasks even in a read-only project', async () => {
  const f = await workflowTaskFixture();
  f.plan.projectIds = ['project:synthetic'];
  const snapshot = { ...f.snapshot, source: { ...f.snapshot.source, owner: { ...f.snapshot.source.owner, projectId: 'project:synthetic' } } };
  const projection = { ...f.projection, source: structuredClone(snapshot.source) };
  const tasks = projectWorkflowAgentTasks(f.plan, snapshot, projection, []);
  expect(tasks.length).toBeGreaterThan(0);
  const ports = { ...desktopStorePorts,
    app: (): ReturnType<typeof desktopStorePorts.app> => ({ ...desktopStorePorts.app(), standaloneProjects: [{ id: 'project:synthetic', name: 'Synthetic', mountName: 'synthetic', metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] }, path: '/synthetic/project', userReadOnly: true, status: 'active', gitSetupState: 'ready', created_at: '2026-01-01T00:00:00Z' }], projectGroups: [] }),
    tasks: () => ({ ...desktopStorePorts.tasks(), tasks }),
  };
  const runtime = new PilotRuntime({ getState: () => ({}) } as never, undefined, ports);
  const internal = runtime as unknown as {
    project(previous: unknown, now: string, runs: [], instance: string, configuration: string): { snapshots: Resource[]; state: unknown };
    decisionRef(command: Command): unknown;
  };
  const result = internal.project(null, '2026-01-01T00:00:00Z', [], 'instance:synthetic', 'synthetic');
  result.snapshots.forEach(assertA1);
  let persisted: string | null = null;
  const kernel = new PilotKernel({ instanceId: 'instance:synthetic',
    storage: { load: async () => persisted, compareAndSwap: async (previous, next) => { if (previous !== persisted) return false; persisted = next; return true; } },
    project: () => result, execute: async () => { throw new Error('Unexpected action'); },
    authorize: async () => { throw new Error('Unexpected authorization'); },
  });
  await kernel.initialize();
  expect(persisted).not.toBeNull();
  expect(result.snapshots.filter(resource => resource.type === 'task')).toEqual([]);
  expect(() => internal.decisionRef({ target: { task_id: pilotTaskId(tasks[0].id), conversation_id: 'conversation', assistant_message_id: 'assistant' } } as unknown as Command)).toThrow();
  expect(pilotStartRejection({ ...tasks[0], draft: false, status: 'Pending', is_blocked: false })).toBe('invalid_reference');
});
