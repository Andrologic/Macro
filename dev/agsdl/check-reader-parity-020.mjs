import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { read } from '../../src/vendor/agsdl/v0.2/reader.mjs';
import { stringify } from '../../src/vendor/agsdl/v0.2/values.mjs';
import { isIP } from '../../src/vendor/agsdl/v0.2/ip.mjs';
import { isIP as nodeIsIP } from 'node:net';

const root = process.argv[2];
if (!root) throw Error('Usage: bun dev/agsdl/check-reader-parity-020.mjs <AgSDL-v0.2.0-checkout>');
const reference = await import(pathToFileURL(resolve(root, 'tooling/0.2/javascript/reader.mjs')).href);
const values = await import(pathToFileURL(resolve(root, 'tooling/0.2/javascript/values.mjs')).href);
const corpus = spawnSync('python3', ['-c', `
import sys, json, base64
sys.path.insert(0, sys.argv[1] + '/tooling/0.2/conformance')
from cases import cases
print(json.dumps([{'name':c['name'], 'bytes':base64.b64encode(c['bytes']).decode(), 'codes':c['codes']} for c in cases()]))
`, resolve(root)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (corpus.status !== 0) throw Error(corpus.stderr || 'Unable to load the official corpus');
const cases = JSON.parse(corpus.stdout);
for (const fixture of cases) {
  const bytes = new Uint8Array(Buffer.from(fixture.bytes, 'base64'));
  const actual = read(bytes);
  assert.equal(stringify(actual), values.stringify(reference.read(bytes)), fixture.name);
  assert.deepEqual([...new Set(actual.findings.map(f => f.code))].sort(), fixture.codes, fixture.name);
  assert.equal(actual.executionSupport, 'not-assessed', fixture.name);
}
assert.equal(cases.length, 112, 'Published 0.2.0 corpus size changed; inspect provenance before updating.');
const addresses = [
  '::', '::1', '1::', '1:2:3:4:5:6:7:8', '::ffff:192.0.2.1',
  '1:2:3:4:5:6:192.0.2.1', 'fe80::1%25eth0', '::%a.b-c:d',
  '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1::2::3', ':::',
  '::ffff:192.00.2.1', '::ffff:256.0.2.1', '::ffff:192.0.2.1:1',
  '1:2:3:4:5:6:7:192.0.2.1', '::%?', '::%', '::%%eth0',
];
for (const address of addresses) assert.equal(isIP(address) === 6, nodeIsIP(address) === 6, address);
console.log(`AgSDL 0.2.0 browser parity: ${cases.length} complete lossless reports and IPv6 checks passed.`);
