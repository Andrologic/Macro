import { expect, test } from 'bun:test';
import { loadCachedArchitectPlanValue } from './architectPlanReadContext';

test('invalidated plan reads cannot repopulate or overwrite the current scope cache', async () => {
  const cache = new Map<string, { expiresAt: number; value?: string; promise?: Promise<string> }>();
  let finishOld!: (value: string) => void;
  const old = loadCachedArchitectPlanValue({ cache, cacheKey: 'plan:example', ttlMs: 100,
    loader: () => new Promise((resolve) => { finishOld = resolve; }) });
  cache.delete('plan:example');
  await loadCachedArchitectPlanValue({ cache, cacheKey: 'plan:example', ttlMs: 100, loader: async () => 'current' });
  finishOld('retired');
  expect(await old).toBe('retired');
  expect(cache.get('plan:example')?.value).toBe('current');
});
