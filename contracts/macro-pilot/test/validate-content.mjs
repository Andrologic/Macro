import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { validateMessage, validateExchange, validatePageContinuation } from '../v2/validate.mjs';
const root = new URL('../v2/fixtures/', import.meta.url);
const fixture = async (name, kind = 'valid') => JSON.parse(await readFile(new URL(`${kind}/${name}.json`, root), 'utf8'));
let count = 0;
for (const kind of ['valid', 'invalid']) {
  for (const name of await readdir(new URL(`${kind}/`, root))) {
    const value = JSON.parse(await readFile(new URL(`${kind}/${name}`, root), 'utf8'));
    const result = validateMessage(value);
    assert.equal(result.valid, kind === 'valid', `${kind}/${name}: ${JSON.stringify(result.errors)}`);
    count++;
  }
}
let exchanges = 0;
for (const name of await readdir(new URL('valid/', root))) {
  if (!name.startsWith('request-') || name === 'request-implement.json') continue;
  const op = name.slice(8, -5);
  const req = await fixture(`request-${op}`);
  const res = await fixture(`response-${op}`);
  assert.equal(validateExchange(req, res).valid, true, op);
  for (const field of ['request_id', 'account_id', 'operation']) {
    const wrong = structuredClone(res);
    wrong[field] = field === 'operation' ? 'account.get' : 'other-demo';
    if (wrong[field] === res[field]) continue;
    assert.equal(validateExchange(req, wrong).valid, false, `${op}: ${field}`);
  }
  exchanges++;
}
const negotiate = await fixture('negotiate');
assert.equal(validateExchange(negotiate, await fixture('negotiated')).valid, true);
assert.equal(validateExchange({...negotiate, supported_versions: ['1.0']}, await fixture('negotiated')).valid, false);
assert.equal(validateExchange(negotiate, await fixture('negotiated-unsupported')).valid, true);
const diffReq = await fixture('request-diff.read');
const diffRes = await fixture('response-diff.read');
for (const field of ['snapshot_id', 'file_id', 'offset_bytes']) {
  const wrong = structuredClone(diffReq);
  wrong.body[field] = field === 'offset_bytes' ? 1 : 'wrong-demo';
  assert.equal(validateExchange(wrong, diffRes).valid, false, field);
}
const catalog = await fixture('request-conversations.list');
assert.equal(validateExchange(catalog, await fixture('response-implement')).valid, false);
const events = await fixture('events-request');
assert.equal(validateExchange(events, await fixture('events-page')).valid, true);
assert.equal(validateExchange({...events, stream_id: 'old-stream'}, await fixture('events-page')).valid, false);
assert.equal(validateExchange({...events, stream_id: null}, await fixture('events-reset')).valid, true);
// Byte offsets count UTF-8 rather than UTF-16 code units, including page boundaries.
const unicode = structuredClone(diffRes);
unicode.result.patch = 'é'; unicode.result.total_bytes = 3; unicode.result.next_offset_bytes = 2;
assert.equal(validateMessage(unicode).valid, true);
unicode.result.next_offset_bytes = 1;
assert.equal(validateMessage(unicode).valid, false);
console.log(`A2: ${count} fixtures and ${exchanges} request/response operations passed; correlation, negotiation, stream and UTF-8 checks passed.`);

const first = await fixture('response-conversation.read');
first.result.page.total = 2; first.result.page.next_cursor = 'cursor-demo';
const second = structuredClone(first);
second.request_id = 'request-page-two'; second.result.page.offset = 1; second.result.page.next_cursor = null;
second.result.items[0].position = 1; second.result.items[0].message_id = 'message-second';
assert.equal(validatePageContinuation(first, second).valid, true);
for (const field of ['snapshot_id', 'revision', 'expires_at']) {
  const wrong = structuredClone(second);
  wrong.result.page[field] = field === 'revision' ? 2 : field === 'expires_at' ? '2026-01-01T00:04:00Z' : 'wrong-snapshot';
  assert.equal(validatePageContinuation(first, wrong).valid, false, field);
}
second.result.items[0].message_id = first.result.items[0].message_id;
assert.equal(validatePageContinuation(first, second).valid, false);
console.log('A2: adjacent-page continuity and stable metadata checks passed.');

// Both registries remain closed; adding v2 does not silently widen v1.
const { default: Ajv2020 } = await import('ajv/dist/2020.js');
const { default: addFormats } = await import('ajv-formats');
const legacyRoot = new URL('../v1/', import.meta.url);
const legacyRegistry = JSON.parse(await readFile(new URL('schema-set.json', legacyRoot), 'utf8'));
const legacyAjv = new Ajv2020({ strict: false });
addFormats(legacyAjv);
for (const resource of legacyRegistry.resources) legacyAjv.addSchema(JSON.parse(await readFile(new URL(resource.path, legacyRoot), 'utf8')));
const legacy = legacyAjv.getSchema(legacyRegistry.root);
for (const name of await readdir(new URL('valid/', root))) {
  const value = JSON.parse(await readFile(new URL(`valid/${name}`, root), 'utf8'));
  assert.equal(legacy(value), false, `v1 accepted ${name}`);
}
const oldReview = JSON.parse(await readFile(new URL('fixtures/valid/review.json', legacyRoot), 'utf8'));
assert.equal(legacy(oldReview), true);
assert.equal(validateMessage(oldReview).valid, false);
assert.equal(legacy({...oldReview, snapshot_id: 'snapshot-demo'}), false);
console.log('A2: cross-version rejection and frozen v1 review shape passed.');
