import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseModelsDevProviders, validCatalogDate, type ModelsDevProvider } from '../../src/shared/ai/modelsDevSchema';

const sourcePath = new URL('./source.json', import.meta.url);
const outputPath = new URL('../../src/shared/ai/modelsDevSnapshot.json', import.meta.url);
const coverage = JSON.parse(await readFile(new URL('./coverage.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const inputIndex = args.indexOf('--source');
const dateIndex = args.indexOf('--date');
const check = args.includes('--check');
let source = JSON.parse(await readFile(sourcePath, 'utf8').catch(() => '{}'));
if (inputIndex >= 0) {
  if (check || !args[inputIndex + 1] || dateIndex < 0 || !validCatalogDate(args[dateIndex + 1])) {
    throw new Error('Use --source <api.json> --date <ISO timestamp> to update, or --check offline');
  }
  const full = parseModelsDevProviders(JSON.parse(await readFile(args[inputIndex + 1], 'utf8')));
  if (!full) throw new Error('Invalid models.dev source');
  const providers: Record<string, ModelsDevProvider> = {};
  for (const [id, provider] of Object.entries(coverage.providers) as [string, ModelsDevProvider][]) {
    const models: ModelsDevProvider['models'] = {};
    for (const modelId of Object.keys(provider.models)) {
      const model = full[id]?.models[modelId];
      if (model) {
        // Per-entry dates come from this fetch, never from untrusted payload metadata.
        const { updatedAt: _updatedAt, ...data } = model;
        models[modelId] = data;
      }
    }
    providers[id] = { id, models };
  }
  source = { source: 'https://models.dev/api.json', fetchedAt: args[dateIndex + 1], providers };
}
const parsed = parseModelsDevProviders(source.providers);
if (!parsed || source.source !== 'https://models.dev/api.json' || !validCatalogDate(source.fetchedAt)) {
  throw new Error('Invalid scoped source');
}
const providers: Record<string, ModelsDevProvider> = {};
for (const [id, provider] of Object.entries(coverage.providers) as [string, ModelsDevProvider][]) {
  const models: ModelsDevProvider['models'] = {};
  for (const [modelId, legacy] of Object.entries(provider.models)) {
    const current = parsed[id]?.models[modelId];
    models[modelId] = { ...(current ?? legacy),
      updatedAt: current ? source.fetchedAt : coverage.legacyFetchedAt };
  }
  providers[id] = { id, models };
}
const snapshot = { source: source.source, fetchedAt: source.fetchedAt,
  license: 'MIT', notice: 'licenses/models.dev-LICENSE.txt', providers };
const serialized = JSON.stringify(snapshot, null, 2) + '\n';
if (check) {
  if (await readFile(outputPath, 'utf8') !== serialized) throw new Error('Snapshot is out of date');
  console.log('Models.dev snapshot is reproducible');
} else {
  await writeFile(sourcePath, JSON.stringify(source, null, 2) + '\n');
  await writeFile(outputPath, serialized);
  console.log(`Generated ${fileURLToPath(outputPath).split('/').at(-1)}`);
}
