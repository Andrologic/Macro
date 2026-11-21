import type { GitCommitDto } from '../types/generated/ipc/GitCommitDto';

export const createGitCommitDto = (
  id = 'abcdef0123451111111111111111111111111111',
): GitCommitDto => ({
  id, hash: id.slice(0, 12), message: 'Synthetic commit', author: 'Test Author',
  date: '2026-09-22T00:00:00Z', status: 'done', parent_ids: [], graph_depth: 0,
  is_branch_point: false, task_id: null,
});
