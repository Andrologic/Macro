// Explicit effect contract for the small set of built-in tools that can be
// safely scheduled together. MCP and unknown tool ids remain sequential.
const PARALLEL_SAFE_READ_TOOL_IDS = new Set([
  'read', 'list', 'glob', 'grep', 'ast_grep',
  'git_status', 'git_log', 'git_diff', 'git_get_tree', 'git_branch_list',
]);

export const MAX_PARALLEL_READS = 3;

export const isParallelSafeReadTool = (id: string): boolean =>
  PARALLEL_SAFE_READ_TOOL_IDS.has(id);
