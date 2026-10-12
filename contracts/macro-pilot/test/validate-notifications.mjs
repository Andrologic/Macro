import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createNotificationsValidator, validateMessage, validateExchange, validateResolution } from '../v2/notifications-validate.mjs';

const root = new URL('../v2/', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const fixture = name => read(`fixtures/notifications/valid/${name}.json`);
const registry = read('notifications-schema-set.json');
assert.equal(registry.resources.length, 2);
assert.deepEqual(registry.resources.map(r => r.path), ['../v1/common.schema.json', 'notifications.schema.json']);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const resource of registry.resources) {
  const schema = read(resource.path);
  assert.equal(schema.$id, resource.id);
  ajv.addSchema(schema);
}
const shape = ajv.getSchema(registry.root);
const fromFactory = createNotificationsValidator(shape);
const semanticOnly = new Set(['resolve-too-long.json', 'resolve-empty-lifetime.json', 'resolve-reversed-lifetime.json', 'error-retryable.json']);
let fixtures = 0;
for (const kind of ['valid', 'invalid']) {
  for (const name of readdirSync(new URL(`fixtures/notifications/${kind}/`, root)).sort()) {
    const value = read(`fixtures/notifications/${kind}/${name}`);
    const expected = kind === 'valid';
    assert.equal(shape(value), expected || semanticOnly.has(name), `AJV ${kind}/${name}`);
    assert.equal(validateMessage(value).valid, expected, `semantic ${kind}/${name}`);
    assert.equal(fromFactory.validateMessage(value).valid, expected, `factory ${kind}/${name}`);
    if (value.body?.token || value.result?.token) {
      const token = value.body?.token ?? value.result.token;
      assert.equal(token.length, 64);
      assert.ok(token.startsWith('synthetic-notification-token-'));
    }
    fixtures++;
  }
}
const operations = ['notifications.register', 'notifications.preference', 'notifications.unregister', 'notification.resolve'];
const requests = operations.map(op => fixture(`request-${op}`));
const responses = operations.map(op => fixture(`response-${op}`));
for (let i = 0; i < requests.length; i++) {
  assert.equal(validateExchange(requests[i], responses[i]).valid, true);
  for (const field of ['request_id', 'account_id']) {
    assert.equal(validateExchange(requests[i], { ...responses[i], [field]: 'different-demo' }).valid, false);
  }
  for (let j = 0; j < responses.length; j++) {
    if (i !== j) assert.equal(validateExchange(requests[i], responses[j]).valid, false);
  }
  for (const code of ['validation_failed','not_found','conflict','stale_revision','resource_limit','forbidden','unavailable']) {
    const error = { ...fixture(`error-${code}`), operation: requests[i].operation };
    assert.equal(validateExchange(requests[i], error).valid, true);
    assert.equal(validateExchange(requests[i], { ...error, account_id: 'different-demo' }).valid, false);
  }
}
assert.equal(validateExchange(fixture('request-register-rotation'), fixture('response-register-rotation')).valid, true);
assert.equal(validateExchange(requests[0], fixture('response-register-rotation')).valid, false);
assert.equal(validateExchange(requests[0], { ...responses[0], result: { ...responses[0].result, enabled: true } }).valid, false);
for (const i of [1, 2]) {
  for (const revision of [requests[i].body.expected_revision, requests[i].body.expected_revision + 2]) {
    assert.equal(validateExchange(requests[i], { ...responses[i], result: { ...responses[i].result, revision } }).valid, false);
  }
  assert.equal(validateExchange(requests[i], { ...responses[i], result: { ...responses[i].result, enrollment_id: 'wrong-enrollment' } }).valid, false);
}
assert.equal(validateExchange(requests[1], { ...responses[1], result: { ...responses[1].result, enabled: false } }).valid, false);
assert.equal(validateExchange(responses[0], requests[0]).valid, false);
for (const value of [null, undefined, 1, {}, [], 'text']) {
  assert.equal(validateMessage(value).valid, false);
  assert.equal(validateExchange(value, responses[0]).valid, false);
  assert.equal(validateResolution(requests[3], responses[3], value).valid, false);
}

// Boundaries use generated synthetic strings; stored token fixtures stay at 64 characters.
function tokenMessage(token) { return { ...requests[0], body: { ...requests[0].body, token } }; }
for (const token of ['x', 'x'.repeat(4096), 'é'.repeat(2048)]) assert.equal(validateMessage(tokenMessage(token)).valid, true);
for (const token of ['', 'x'.repeat(4097), 'é'.repeat(2049)]) assert.equal(validateMessage(tokenMessage(token)).valid, false);
for (const field of ['request_id', 'account_id']) {
  for (const id of ['a', 'a'.repeat(128)]) assert.equal(validateMessage({ ...requests[0], [field]: id }).valid, true);
  for (const id of ['', 'a'.repeat(129), 'bad/id', 'é']) assert.equal(validateMessage({ ...requests[0], [field]: id }).valid, false);
}
for (const application of ['a', 'a'.repeat(200)]) {
  assert.equal(validateMessage({ ...requests[0], body: { ...requests[0].body, application } }).valid, true);
}
for (const application of ['', 'a'.repeat(201), 'a b', '/app', 'app\n']) {
  assert.equal(validateMessage({ ...requests[0], body: { ...requests[0].body, application } }).valid, false);
}
for (const expected_revision of [1, Number.MAX_SAFE_INTEGER]) {
  assert.equal(validateMessage({ ...requests[1], body: { ...requests[1].body, expected_revision } }).valid, true);
}
const maxRevision = { ...requests[1], body: { ...requests[1].body, expected_revision: Number.MAX_SAFE_INTEGER } };
assert.equal(validateExchange(maxRevision, { ...responses[1], result: { ...responses[1].result, revision: Number.MAX_SAFE_INTEGER } }).valid, false);

const actor = { account_id: 'account-demo', session_id: 'session-demo', device_id: 'device-demo', active: true, account_active: true, session_generation: 1 };
const scope = { account_id: actor.account_id, session_id: actor.session_id, device_id: actor.device_id, session_generation: 1 };
const context = {
  now: Date.parse('2026-01-01T00:05:00Z'), actor,
  enrollment: { ...scope, enrollment_id: 'enrollment-demo', revision: 2, state: 'active', enabled: true },
  notification: { ...scope, enrollment_id: 'enrollment-demo', enrollment_revision: 2, notification_id: 'notification-demo', instance_id: 'instance-demo', observed_at: responses[3].result.observed_at, expires_at: responses[3].result.expires_at, access_generation: 1, producer_generation: 1 },
  access: { account_id: actor.account_id, session_id: actor.session_id, instance_id: 'instance-demo', active: true, permission: 'supervise', generation: 1 },
  producer: { instance_id: 'instance-demo', active: true, generation: 1 }
};
assert.equal(validateResolution(requests[3], responses[3], context).valid, true);
let denied = 0;
function deny(section, field, value) {
  const wrong = structuredClone(context);
  wrong[section][field] = value;
  assert.equal(validateResolution(requests[3], responses[3], wrong).valid, false, `${section}.${field}`);
  denied++;
}
for (const section of ['enrollment', 'notification']) {
  for (const field of ['account_id', 'session_id', 'device_id', 'enrollment_id']) deny(section, field, 'different-demo');
  deny(section, 'session_generation', 2);
}
for (const [section, fields] of Object.entries({
  actor: { active: false, account_active: false, account_id: 'different-demo', session_id: 'different-demo', device_id: 'different-demo', session_generation: 2 },
  enrollment: { enabled: false, state: 'removed', revision: 3 },
  notification: { notification_id: 'different-demo', enrollment_revision: 1, instance_id: 'different-demo', producer_generation: 2, access_generation: 2, observed_at: '2026-01-01T00:00:01Z', expires_at: '2026-01-01T00:14:59Z' },
  access: { active: false, permission: 'read', account_id: 'different-demo', session_id: 'different-demo', instance_id: 'different-demo', generation: 2 },
  producer: { active: false, instance_id: 'different-demo', generation: 2 }
})) for (const [field, value] of Object.entries(fields)) deny(section, field, value);
for (const field of ['actor','enrollment','notification','access','producer','now']) {
  const wrong = structuredClone(context); delete wrong[field];
  assert.equal(validateResolution(requests[3], responses[3], wrong).valid, false);
}
for (const now of [Date.parse('2025-12-31T23:59:59Z'), Date.parse('2026-01-01T00:15:00Z'), NaN, Infinity]) {
  assert.equal(validateResolution(requests[3], responses[3], { ...context, now }).valid, false);
}
assert.equal(validateResolution(requests[3], responses[3], { ...context, now: Date.parse('2026-01-01T00:00:00Z') }).valid, true);
assert.equal(validateResolution(requests[0], responses[0], context).valid, false);

// Frozen v1 consumers refuse every new envelope. No legacy v2 registry is needed.
const v1Root = new URL('../v1/', import.meta.url);
const legacyRegistry = JSON.parse(readFileSync(new URL('schema-set.json', v1Root), 'utf8'));
const legacyAjv = new Ajv2020({ strict: false });
addFormats(legacyAjv);
for (const resource of legacyRegistry.resources) legacyAjv.addSchema(JSON.parse(readFileSync(new URL(resource.path, v1Root), 'utf8')));
const legacy = legacyAjv.getSchema(legacyRegistry.root);
for (const name of readdirSync(new URL('fixtures/notifications/valid/', root))) {
  assert.equal(legacy(read(`fixtures/notifications/valid/${name}`)), false, `v1 accepted ${name}`);
}
assert.equal(legacy(JSON.parse(readFileSync(new URL('fixtures/valid/review.json', v1Root), 'utf8'))), true);
console.log(`Notifications: ${fixtures} fixtures, direct AJV, four correlated operations, bounds, frozen v1 rejection and ${denied} stale resolution contexts passed.`);
