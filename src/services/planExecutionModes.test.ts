import { describe, expect, it } from 'bun:test';
import type { PlanNode } from '../types';
import { getPlanExecutionModesByProjectId } from './planExecutionModes';
import { resolvePlanProjectExecutionMode } from './planExecutionModes';

const node = (
  id: string,
  projectId: string,
  mode: 'git' | 'direct',
): PlanNode => ({
  id,
  title: id,
  description: '',
  type: 'task',
  status: 'pending',
  dependencies: [],
  projectId,
  projectIds: [projectId],
  executionModesByProjectId: { [projectId]: mode },
});

describe('getPlanExecutionModesByProjectId', () => {
  it('keeps the persisted plan mode authoritative for newly generated nodes', () => {
    expect(getPlanExecutionModesByProjectId(
      [node('git-task', 'docs', 'git')],
      { docs: 'direct' },
    )).toEqual({ docs: 'direct' });
  });

  it('keeps a direct-only plan direct', () => {
    expect(getPlanExecutionModesByProjectId([node('direct-task', 'docs', 'direct')]))
      .toEqual({ docs: 'direct' });
  });

  it('uses Git for finalization after a project transitions from direct editing to Git', () => {
    expect(getPlanExecutionModesByProjectId([
      node('old-direct-task', 'docs', 'direct'),
      node('new-git-task', 'docs', 'git'),
    ])).toEqual({ docs: 'git' });
  });

  it('does not let a persisted Git mode bypass the current blocked project state', () => {
    expect(resolvePlanProjectExecutionMode({
      projectId: 'docs',
      nodes: [node('git-task', 'docs', 'git')],
      project: {
        id: 'docs',
        name: 'Docs',
        mountName: 'docs',
        path: 'C:/work/docs',
        created_at: '2026-08-28T00:00:00.000Z',
        status: 'active',
        gitSetupState: 'unborn',
        isReadOnly: true,
        metadata: { description: '', tags: [], team_members: [], api_contracts: [], dependencies: [] },
      },
    })).toBe('blocked');
  });
});
