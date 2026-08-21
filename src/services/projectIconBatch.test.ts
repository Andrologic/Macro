import { describe, expect, it } from 'bun:test';
import { createProjectIconBatch } from './projectIconBatch';

const icon = (projectId: string) => ({
  dataUrl: `data:image/png;base64,${projectId}`,
  sourcePath: `${projectId}.png`,
  revision: `${projectId}-revision`,
});

describe('createProjectIconBatch', () => {
  it('rejects invalid batch sizes', () => {
    expect(() => createProjectIconBatch(async () => [], 0)).toThrow(RangeError);
  });

  it('groups requests from the same turn and deduplicates project ids', async () => {
    const calls: string[][] = [];
    const resolveIcon = createProjectIconBatch(async (projectIds) => {
      calls.push(projectIds);
      return projectIds.map((projectId) => ({ projectId, icon: icon(projectId) }));
    });

    const [first, firstDuplicate, second] = await Promise.all([
      resolveIcon('first'),
      resolveIcon('first'),
      resolveIcon('second'),
    ]);

    expect(calls).toEqual([['first', 'second']]);
    expect(first).toEqual(icon('first'));
    expect(firstDuplicate).toEqual(icon('first'));
    expect(second).toEqual(icon('second'));
  });

  it('splits large request sets and returns null for missing resolutions', async () => {
    const calls: string[][] = [];
    const resolveIcon = createProjectIconBatch(async (projectIds) => {
      calls.push(projectIds);
      return projectIds
        .filter((projectId) => projectId !== 'missing')
        .map((projectId) => ({ projectId, icon: icon(projectId) }));
    }, 2);

    const results = await Promise.all([
      resolveIcon('first'),
      resolveIcon('missing'),
      resolveIcon('third'),
    ]);

    expect(calls).toEqual([['first', 'missing'], ['third']]);
    expect(results).toEqual([icon('first'), null, icon('third')]);
  });
});
