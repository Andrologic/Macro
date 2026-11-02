import { expect, test } from 'bun:test';
import { createDemoWorkflowDraftWriter, type DemoWorkflowDraft } from './blueprintDraft';
import type { DemoBlueprintUse } from './blueprintLaunch';

const draft = (objective: string): DemoWorkflowDraft => ({
  id: 'draft-1', blueprintId: 'blueprint-1', projectId: 'project-1', objective, values: { model: 'Demo' },
});
const saved = (input: DemoWorkflowDraft): DemoBlueprintUse => ({
  id: input.id, projectId: input.projectId, objective: input.objective, values: input.values,
  blueprint: { id: input.blueprintId, projectIds: [input.projectId], title: 'Example', description: '', fields: [], agents: [] },
  taskIds: [], state: 'prepared',
});

test('autosaves preserve input order and a final close/launch write waits for earlier input', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const writer = createDemoWorkflowDraftWriter(async input => {
    calls.push(input.objective);
    if (calls.length === 1) await gate;
    return saved(input);
  });
  const first = writer.save(draft('first'));
  const latest = draft('latest');
  const final = writer.save(latest);
  latest.objective = 'changed outside the queue';
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toEqual(['first']);
  release();
  await first;
  expect((await final).objective).toBe('latest');
  expect((await writer.flush())?.objective).toBe('latest');
  expect(calls).toEqual(['first', 'latest']);
});

test('a failed autosave does not prevent a later retry from preserving the draft', async () => {
  let attempts = 0;
  const writer = createDemoWorkflowDraftWriter(async input => {
    if (++attempts === 1) throw new Error('Temporary failure');
    return saved(input);
  });
  await expect(writer.save(draft('first'))).rejects.toThrow('Temporary failure');
  expect((await writer.save(draft('retry'))).objective).toBe('retry');
});
