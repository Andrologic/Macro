import { describe, expect, it } from 'bun:test';
import { getProjectCapabilities } from './projectCapabilities';

describe('project capabilities', () => {
  it('keeps basic Git available while exposing WSL workflow refusals', () => {
    for (const path of ['\\\\wsl$\\Ubuntu\\home\\repo', '//wsl.localhost/Ubuntu/home/repo']) {
      expect(getProjectCapabilities({ path })).toEqual({ metadata: false, worktrees: false, review: false, mergeWorkflow: false, gitOperations: true, reason: 'wsl' });
    }
    expect(getProjectCapabilities({ path: '/home/repo', pathKind: 'wsl' }).review).toBe(false);
  });
  it('preserves capabilities for native and other network paths', () => {
    for (const path of ['/repo', 'C:\\repo', '\\\\server\\share\\repo']) {
      expect(getProjectCapabilities({ path })).toEqual({ metadata: true, worktrees: true, review: true, mergeWorkflow: true, gitOperations: true, reason: null });
    }
  });
});
