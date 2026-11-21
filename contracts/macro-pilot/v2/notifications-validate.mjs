import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/** Portable rules. A browser generator can supply its compiled AJV shape. */
export function createNotificationsValidator(shape) {
  if (typeof shape !== 'function') throw new TypeError('Compiled notification schema required');
  const fail = reason => ({ valid: false, errors: [reason] });
  const success = () => ({ valid: true, errors: [] });
  const revision = value => Number.isSafeInteger(value) && value >= 1;
  const bytes = value => new TextEncoder().encode(value).length;

  /** Synchronous shape and within-envelope checks; does not authorize an actor. */
  function validateMessage(message) {
    // AJV diagnostics can copy unknown property names supplied by the caller.
    // Return a fixed reason so tokens in malformed keys remain private.
    try {
      if (!shape(message)) return fail('Invalid notification envelope');
      if (bytes(JSON.stringify(message)) > 262144) return fail('Envelope exceeds 256 KiB');
    } catch { return fail('Invalid notification envelope'); }
    if (message.type === 'request' && message.operation === 'notifications.register'
      && bytes(message.body.token) > 4096) return fail('Token exceeds 4096 UTF-8 bytes');
    if (message.type === 'error' && message.code !== 'unavailable' && message.retryable)
      return fail('Only unavailable may be retryable');
    if (message.type === 'response' && message.operation === 'notification.resolve') {
      const lifetime = Date.parse(message.result.expires_at) - Date.parse(message.result.observed_at);
      if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 900000)
        return fail('Notification lifetime must be positive and at most 15 minutes');
    }
    return success();
  }

  /** Stateless correlation, initial consent, CAS increment and mutation receipts. */
  function validateExchange(request, response) {
    for (const message of [request, response]) {
      const result = validateMessage(message);
      if (!result.valid) return result;
    }
    if (request.type !== 'request' || !['response', 'error'].includes(response.type))
      return fail('Expected request and response or error');
    for (const field of ['contract_version', 'request_id', 'account_id', 'operation']) {
      if (request[field] !== response[field]) return fail('Exchange correlation mismatch');
    }
    if (response.type === 'error') return success();
    const b = request.body;
    const r = response.result;
    if (request.operation === 'notification.resolve') return success();
    if ('enrollment_id' in b && b.enrollment_id !== r.enrollment_id)
      return fail('Enrollment correlation mismatch');
    if ('expected_revision' in b && r.revision !== b.expected_revision + 1)
      return fail('CAS revision must increase by one');
    if (request.operation === 'notifications.register' && !('enrollment_id' in b)
      && (r.revision !== 1 || r.enabled !== false)) return fail('Initial enrollment requires revision one and consent off');
    if (request.operation === 'notifications.preference' && b.enabled !== r.enabled)
      return fail('Preference receipt mismatch');
    return success();
  }

  /** Current trusted snapshot only. This helper never reads auth from the body. */
  function validateResolution(request, response, context) {
    const exchange = validateExchange(request, response);
    if (!exchange.valid) return exchange;
    if (request.operation !== 'notification.resolve' || response.type !== 'response')
      return fail('Expected successful notification resolution');
    const { actor: a, enrollment: e, notification: n, access: x, producer: p, now } = context ?? {};
    if (!a || !e || !n || !x || !p || !Number.isFinite(now)) return fail('Current trusted resolution context required');
    if (a.active !== true || a.account_active !== true || !revision(a.session_generation))
      return fail('Account or authenticated session is inactive');
    if (request.account_id !== a.account_id) return fail('Authenticated account mismatch');
    for (const record of [e, n]) {
      for (const field of ['account_id', 'session_id', 'device_id']) {
        if (typeof a[field] !== 'string' || !a[field] || record[field] !== a[field])
          return fail('Notification actor scope mismatch');
      }
      if (record.session_generation !== a.session_generation) return fail('Session generation mismatch');
    }
    if (e.state !== 'active' || e.enabled !== true || !revision(e.revision)
      || n.enrollment_revision !== e.revision) return fail('Enrollment consent or revision is no longer current');
    if (typeof e.enrollment_id !== 'string' || !e.enrollment_id || n.enrollment_id !== e.enrollment_id
      || n.notification_id !== request.body.notification_id) return fail('Notification enrollment mismatch');
    const r = response.result;
    if (n.instance_id !== r.destination.instance_id || n.observed_at !== r.observed_at || n.expires_at !== r.expires_at)
      return fail('Resolved destination or lifetime mismatch');
    const observed = Date.parse(n.observed_at);
    const expires = Date.parse(n.expires_at);
    if (!Number.isFinite(observed) || !Number.isFinite(expires) || now < observed || now >= expires)
      return fail('Notification is outside its validity window');
    if (x.active !== true || x.permission !== 'supervise' || x.account_id !== a.account_id
      || x.session_id !== a.session_id || x.instance_id !== n.instance_id
      || !revision(x.generation) || n.access_generation !== x.generation)
      return fail('Current supervise access required');
    if (p.active !== true || p.instance_id !== n.instance_id || !revision(p.generation)
      || n.producer_generation !== p.generation) return fail('Current producer required');
    return success();
  }
  return { validateMessage, validateExchange, validateResolution };
}

// Node/Bun registry loader. The factory above has no filesystem or Node dependency.
const directory = new URL('./', import.meta.url);
const registry = JSON.parse(readFileSync(new URL('notifications-schema-set.json', directory), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const resource of registry.resources) {
  const schema = JSON.parse(readFileSync(new URL(resource.path, directory), 'utf8'));
  if (schema.$id !== resource.id) throw new Error(`Schema id mismatch: ${resource.path}`);
  ajv.addSchema(schema);
}
export const { validateMessage, validateExchange, validateResolution } = createNotificationsValidator(ajv.getSchema(registry.root));
