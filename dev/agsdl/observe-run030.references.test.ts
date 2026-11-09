import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareObserved030 } from './compare-observed030';

// Optional external native evidence. Keep machine paths and databases outside
// the public repository. The regular suite always runs the synthetic SQL tests.
const referenceDir = process.env.MACRO_AGSDL030_REFERENCE_DIR;
test.skipIf(!referenceDir)('keeps all ten qualified native projections byte-for-byte identical, without writing SQLite or references', async () => {
  const directory = referenceDir!;
  const names = readdirSync(directory).filter((name) => name.endsWith('-scenario-observed.json')).sort();
  expect(names.length).toBe(10);
  const copies = mkdtempSync(join(tmpdir(), 'agsdl-r4-observer-'));
  try {
    for (const name of names) {
      const prefix = name.slice(0, -'-observed.json'.length);
      const database = join(directory, `${prefix}-delete.sqlite`), reference = join(directory, name);
      const before = createHash('sha256').update(readFileSync(database)).digest('hex');
      const copy = join(copies, `${prefix}.sqlite`); copyFileSync(database, copy);
      const expected = readFileSync(reference);
      const compared = await compareObserved030(join(directory, `${prefix}-native-result.json`), copy);
      expect(compared.diagnostics).toEqual([]);
      expect(Buffer.from(compared.observedJson)).toEqual(expected);
      expect(readFileSync(reference)).toEqual(expected);
      expect(createHash('sha256').update(readFileSync(database)).digest('hex')).toBe(before);
      expect(createHash('sha256').update(readFileSync(copy)).digest('hex')).toBe(before);
    }
  } finally { rmSync(copies, { recursive: true, force: true }); }
});
