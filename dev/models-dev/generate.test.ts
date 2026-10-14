import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { parseModelsDevProviders } from '../../src/shared/ai/modelsDevSchema';
import coverage from './coverage.json';
import source from './source.json';
import snapshot from '../../src/shared/ai/modelsDevSnapshot.json';

describe('models.dev snapshot maintenance', () => {
  it('reproduces the checked-in snapshot offline', async () => {
    const process = Bun.spawn(['bun', 'dev/models-dev/generate.ts', '--check'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await process.exited).toBe(0);
  });

  it('keeps exactly the original scope, dates, and MIT attribution', async () => {
    const parsed = parseModelsDevProviders(snapshot.providers);
    expect(parsed).not.toBeNull();
    expect(Object.keys(snapshot.providers)).toEqual(Object.keys(coverage.providers));
    for (const [providerId, provider] of Object.entries(coverage.providers)) {
      const models = snapshot.providers[providerId as keyof typeof snapshot.providers].models;
      expect(Object.keys(models)).toEqual(Object.keys(provider.models));
      for (const [id, model] of Object.entries(models)) {
        const current = (source.providers[providerId as keyof typeof source.providers].models as Record<string, unknown>)[id];
        expect(model.updatedAt).toBe(current ? source.fetchedAt : coverage.legacyFetchedAt);
      }
    }
    expect(snapshot.license).toBe('MIT');
    expect(await readFile(new URL(`../../public/${snapshot.notice}`, import.meta.url), 'utf8')).toContain('Copyright (c) 2025 models.dev');
    expect(JSON.stringify(snapshot)).not.toContain('pricing');
    expect(JSON.stringify(snapshot)).not.toContain('budget_tokens');
  });
});
