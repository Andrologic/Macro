import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixtures from '../../contracts/macro-pilot/v2/portable-chat-history/fixtures.json';
import { PortableWorkBudget } from '../services/ai/portableHistoryInspection';
import { validatePortableRecipe } from './portableContractRecipe';
import { policy } from '../services/ai/portableHistoryFixtures.testSupport';

test('late manifest/header/association refusals delete receiving staging before any native BEGIN or append', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portable-contract-'));
  try {
    for (const where of ['manifest', 'header', 'association']) {
      const descriptor = structuredClone(fixtures.descriptor), frames: unknown[] = fixtures.headers.map((header, i) => ({ header: structuredClone(header), offset: 0, data: fixtures.payloadBase64[i] }));
      if (where === 'manifest') descriptor.manifest_sha256 = 'f'.repeat(64);
      if (where === 'header') (frames.at(-1) as { header: { sha256: string } }).header.sha256 = 'f'.repeat(64);
      if (where === 'association') {
        descriptor.records++;
        frames.push({ header: { ordinal: 3, entry: { kind: 'association', from: 999, to: 2, position: 0, relation: 'data_for_message' }, bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }, offset: 0, data: '' });
      }
      const path = join(dir, where), destination = join(dir, where + '.receiving');
      await writeFile(path, [descriptor, ...frames].map(v => JSON.stringify(v) + '\n').join(''), { mode: 0o600 });
      const budget = new PortableWorkBudget(16 * 1024 * 1024); let nativeBegins = 0, nativeAppends = 0, sealed = false;
      const receive = async () => {
        const result = await validatePortableRecipe(path, destination, budget, { ...policy, revision: 'fixture' });
        // The native stage is unreachable on a late failure, not an IPC adapter.
        nativeBegins++; nativeAppends += result.fragments; sealed = true;
      };
      await expect(receive()).rejects.toThrow();
      expect(nativeBegins).toBe(0); expect(nativeAppends).toBe(0); expect(sealed).toBe(false);
      await expect(access(destination)).rejects.toThrow(); expect(budget.used).toBe(0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
