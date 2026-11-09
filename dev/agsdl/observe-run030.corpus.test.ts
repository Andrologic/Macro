import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeRun030 } from './observe-run030';

// The auditor's corpus stays external and untouched. Include WAL/SHM in both
// the copy and the source hashes, even when the delivered corpus has none.
const auditDir = process.env.MACRO_AGSDL030_AUDIT_DIR;
type Probe = { name: string; path: string };
const probes: Probe[] = auditDir ? JSON.parse(readFileSync(join(auditDir, 'all-mutation-results.json'), 'utf8')) : [];
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
describe.skipIf(!auditDir || !process.env.MACRO_AGSDL030_REPLAY_COMMAND)('native replay and host checks on the independent corpus', () => {
  test('retains all 220 negative probes and the malformed 037 control', () => {
    expect(probes).toHaveLength(221);
    expect(probes.filter((p) => p.name === 'content-correct-control')).toHaveLength(1);
  });
  test.each(probes)('refuses $name on a disposable copy', (probe) => {
    const directory = mkdtempSync(join(tmpdir(), 'agsdl-combined-corpus-')), copy = join(directory, 'run.sqlite');
    const originals = ['', '-wal', '-shm'].filter((ext) => existsSync(probe.path + ext)).map((ext) => ({ path: probe.path + ext, digest: sha(probe.path + ext), ext }));
    try {
      for (const file of originals) copyFileSync(file.path, copy + file.ext);
      const db = new Database(copy, { readonly: true });
      const run = db.query('SELECT system_id,invocation_id FROM engine_flow030_runs').get() as { system_id: string; invocation_id: string };
      db.close();
      // content-correct-control uses forged digest/fingerprint "audit" and a
      // FlowIdentity where 037 requires a content identity. Its refusal is an
      // expected corpus anomaly, not a genuine positive or a security mutation.
      expect(() => observeRun030(copy, run.system_id, run.invocation_id)).toThrow();
    } finally {
      for (const file of originals) expect(sha(file.path)).toBe(file.digest);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
