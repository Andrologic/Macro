import { describe, expect, it } from 'bun:test';
import type { ImplementTask } from '../../stores/useTaskStore';
import { filterTasksByQuery } from './taskQueueSearch';

const task = (id: string, title: string): ImplementTask => ({
  id,
  title,
  description: '',
} as ImplementTask);

describe('task queue search', () => {
  const tasks = [
    task('one', 'Préparer le déploiement'),
    task('two', 'Réparer la navigation'),
  ];

  it('matches task titles without case or accent sensitivity', () => {
    expect(filterTasksByQuery(tasks, 'DEPLOIEMENT').map((item) => item.id)).toEqual(['one']);
  });

  it('keeps the input order for an empty query', () => {
    expect(filterTasksByQuery(tasks, '').map((item) => item.id)).toEqual(['one', 'two']);
  });

  it('returns no task when the query does not match', () => {
    expect(filterTasksByQuery(tasks, 'conversation')).toEqual([]);
  });
});
