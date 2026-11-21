import { expect,test } from 'bun:test';
import { desktopStorePorts } from '../../composition/macroPilotDesktop';
import { projectWorkflowAgentTasks030 } from '../workflowAgentTasks';
import { workflowTaskFixture } from '../workflowAgentTasks.fixtures';
import { PilotKernel } from './kernel';
import type { Command,Resource } from './protocol';
import { assertA1 } from './protocol';
import { PilotRuntime } from './runtime';
import { pilotStartRejection } from './startEligibility';
import { pilotTaskId } from './taskIdentity';

test('runtime projection and action resolution exclude real AgSDL tasks even in a read-only project', async () => {
  const f = await workflowTaskFixture();
  f.plan.projectIds = ['project:synthetic'];
  f.snapshot.source.owner.projectId = 'project:synthetic';
  const inspection = await f.ports.inspect!(f.snapshot);
  const tasks = projectWorkflowAgentTasks030(f.plan, inspection);
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
