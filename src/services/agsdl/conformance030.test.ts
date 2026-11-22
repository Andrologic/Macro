import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const fixture = (path: string) => new URL(`dev/agsdl/fixtures/v0.4/${path}`, root);
const readFixture = (path: string) => readFileSync(fixture(path));
const cases = readdirSync(fixture('conformance/cases')).filter(p => p.endsWith('.json')).sort();
const examples = readdirSync(fixture('examples')).filter(p => p.endsWith('.json')).sort();
const runs = readdirSync(fixture('conformance/runs')).filter(p => p.endsWith('.json')).sort();
const expected: Record<string, { errors: string[]; warnings: string[] }> = JSON.parse(readFixture('conformance/expected.json').toString());
describe('byte-pinned AgSDL 0.4 conformance', () => {
  it('verifies provenance and exhaustive published corpus membership', () => {
    const manifest = JSON.parse(readFixture('provenance.json').toString()) as { tagObject: string; commit: string; files: { path: string; sha256: string }[] };
    expect(manifest.tagObject).toBe('fbe06efb1e0568ad0f6d2fbe5a134ec9e09a37c6');
    expect(manifest.commit).toBe('65e6529b0af3d1adba1dd9a1419e03c0ec347f21');
    for (const file of manifest.files) expect(createHash('sha256').update(readFileSync(new URL(file.path, root))).digest('hex')).toBe(file.sha256);
    expect(cases).toEqual(Object.keys(expected).map(name => `${name}.json`).sort());
    expect([cases.length, examples.length, runs.length]).toEqual([147, 10, 50]);
  });
});
