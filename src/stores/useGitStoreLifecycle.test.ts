import { afterAll, expect, mock, test } from 'bun:test';
import type { GitCommit } from '../types';
const replies: Array<(result: { commits: GitCommit[] }) => void> = [];
mock.module('../services', () => ({ services: {
  listCommits: () => new Promise((resolve) => { replies.push(resolve); }),
} }));
const { useGitStore } = await import('./useGitStore');
afterAll(() => mock.restore());
test('targeted eviction does not let an old project read overwrite its replacement', async () => {
  const old = useGitStore.getState().loadCommits('project-a');
  useGitStore.setState({ commitsByProject: { 'project-b': [] } });
  useGitStore.getState().invalidateProject('project-a');
  const next = useGitStore.getState().loadCommits('project-a');
  replies[1]({ commits: [] });
  await next;
  const current = useGitStore.getState().commitsByProject['project-a'];
  replies[0]({ commits: [{ id: 'retired' } as unknown as GitCommit] });
  await old;
  expect(useGitStore.getState().commitsByProject['project-a']).toBe(current);
  expect(useGitStore.getState().commitsByProject['project-b']).toEqual([]);
});
