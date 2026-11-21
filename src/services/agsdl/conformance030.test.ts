import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const fixture = (path: string) => new URL(`dev/agsdl/fixtures/v0.3/${path}`, root);
const readFixture = (path: string) => readFileSync(fixture(path));
const cases = readdirSync(fixture('conformance/cases')).filter(p => p.endsWith('.json')).sort();
const examples = readdirSync(fixture('examples')).filter(p => p.endsWith('.json')).sort();
const runs = readdirSync(fixture('conformance/runs')).filter(p => p.endsWith('.json')).sort();
const expected: Record<string, { errors: string[]; warnings: string[] }> = JSON.parse(readFixture('conformance/expected.json').toString());
describe('byte-pinned AgSDL 0.3 conformance', () => {
  it('verifies provenance and exhaustive published corpus membership', () => {
    const manifest = JSON.parse(readFixture('provenance.json').toString()) as { tagObject: string; commit: string; files: { path: string; sha256: string }[] };
    expect(manifest.tagObject).toBe('4dd9b647cd9d477e5d07e089f23f3a1e7728ea39');
    expect(manifest.commit).toBe('bd9f8a5b16923476fd20ac2650bd1729ee151917');
    for (const file of manifest.files) expect(createHash('sha256').update(readFileSync(new URL(file.path, root))).digest('hex')).toBe(file.sha256);
    expect(cases).toEqual(Object.keys(expected).map(name => `${name}.json`).sort());
    expect([cases.length, examples.length, runs.length]).toEqual([144, 10, 37]);
  });
});
