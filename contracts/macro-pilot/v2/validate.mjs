import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// Public conformance helper, deliberately separate from the shipped v1 runtime.
const directory = new URL('./', import.meta.url);
const registry = JSON.parse(await readFile(new URL('schema-set.json', directory), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const resource of registry.resources) {
  const schema = JSON.parse(await readFile(new URL(resource.path, directory), 'utf8'));
  if (schema.$id !== resource.id) throw new Error(`Schema id mismatch: ${resource.path}`);
  ajv.addSchema(schema);
}
const shape = ajv.getSchema(registry.root);
const protectedPath = (path) => path && /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|credentials\.json|id_rsa|id_ed25519)(?:\/|$)|\.(?:key|p12)$/i.test(path);
const bytes = (s) => Buffer.byteLength(s, 'utf8');

/** Shape and within-envelope invariants. Authorization and freshness require state. */
export function validateMessage(message) {
  if (!shape(message)) return { valid: false, errors: structuredClone(shape.errors) };
  const errors = [];
  const reject = (condition, reason) => { if (condition) errors.push(reason); };
  reject(bytes(JSON.stringify(message)) > 262144, 'envelope exceeds 256 KiB');
  function walk(value, key = '') {
    if (typeof value === 'string' && ['text', 'patch', 'title'].includes(key)) {
      reject(bytes(value) > 16384, `${key} exceeds 16 KiB UTF-8`);
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
    }
  }
  walk(message);
  if (message.type === 'accepted') reject(message.exchange_id !== message.request_id, 'exchange identity mismatch');
  if (message.type === 'delivery') {
    reject(message.request_id !== message.request.request_id || message.account_id !== message.request.account_id, 'delivery correlation mismatch');
    const scope = message.request.body.ref ?? message.request.body;
    reject(scope.instance_id !== message.instance_id, 'delivery instance mismatch');
    reject(!validateMessage(message.request).valid, 'invalid delivered request');
  }
  if (message.type === 'delivery.result') {
    reject(message.request_id !== message.response.request_id, 'result correlation mismatch');
    reject(!validateMessage(message.response).valid, 'invalid delivered response');
  }
  if (message.type === 'error') reject(message.retryable !== ['unavailable', 'instance_offline'].includes(message.code), 'incorrect retryability');
  const result = message.result;
  const page = result?.page;
  if (page) {
    reject(Date.parse(page.expires_at) <= Date.parse(page.observed_at) || Date.parse(page.expires_at) - Date.parse(page.observed_at) > 300000, 'page lifetime must be within five minutes');
    reject(page.offset + result.items.length > page.total, 'page exceeds total');
    reject((page.next_cursor === null) !== (page.offset + result.items.length === page.total), 'cursor does not match remaining items');
    reject(result.items.length === 0 && page.next_cursor !== null, 'empty nonterminal page');
    const identities = result.items.map((item) => item.message_id ?? item.file_id ?? item.session_id ?? item.project_id ?? item.ref?.conversation_id);
    reject(new Set(identities).size !== identities.length, 'duplicate page identities');
    result.items.forEach((item, index) => {
      if ('position' in item) reject(item.position !== page.offset + index, 'noncontiguous positions');
      if ('content_state' in item && 'role' in item) {
        reject(item.content_state === 'pending' && (item.role !== 'assistant' || item.completion !== 'unknown' || item.reason !== 'generating'), 'invalid pending message');
        reject(item.content_state === 'withheld' && item.reason === 'generating', 'withheld is not generating');
      }
      if ('file_id' in item) {
        reject(protectedPath(item.old_path) || protectedPath(item.new_path), 'credential path must be withheld');
        reject(item.old_path === null && item.new_path === null && item.content_state !== 'withheld', 'file has no path');
        reject(item.content_state !== 'text' && item.patch_bytes !== 0, 'unavailable file advertises patch bytes');
        reject(item.content_state !== 'withheld' && item.change === 'added' && (item.old_path !== null || item.new_path === null), 'invalid added paths');
        reject(item.content_state !== 'withheld' && item.change === 'deleted' && (item.new_path !== null || item.old_path === null), 'invalid deleted paths');
      }
    });
  }
  if (message.type === 'request') {
    reject(message.body.continuation && message.body.snapshot_id && message.body.continuation.snapshot_id !== message.body.snapshot_id, 'continuation snapshot mismatch');
  }
  if (message.type === 'response' && message.operation === 'review.get') {
    reject(Date.parse(result.expires_at) <= Date.parse(result.observed_at) || Date.parse(result.expires_at) - Date.parse(result.observed_at) > 300000, 'capture lifetime must be within five minutes');
  }
  if (message.type === 'response' && message.operation === 'diff.read') {
    const end = result.offset_bytes + bytes(result.patch);
    reject(end > result.total_bytes, 'patch exceeds total');
    reject(result.next_offset_bytes !== (end === result.total_bytes ? null : end), 'patch continuation mismatch');
    reject(result.patch.length === 0 && result.next_offset_bytes !== null, 'empty nonterminal patch');
  }
  if (message.type === 'event') {
    reject(message.change.scope.account_id && message.change.scope.account_id !== message.account_id, 'cross-account event');
  }
  if (message.type === 'events.page') {
    reject(message.next_sequence !== message.after_sequence + message.events.length, 'event sequence end mismatch');
    reject(message.reset && (message.events.length !== 0 || message.after_sequence !== 0 || message.next_sequence !== 0), 'reset must establish empty stream at zero');
    message.events.forEach((event, index) => {
      reject(event.account_id !== message.account_id || event.stream_id !== message.stream_id || event.sequence !== message.after_sequence + index + 1, 'event stream mismatch');
      const checked = validateMessage(event);
      reject(!checked.valid, 'invalid event semantics');
    });
  }
  return { valid: errors.length === 0, errors };
}

/** Validate a response against the exact outstanding request, before caching it. */
export function validateExchange(request, response) {
  const errors = [...validateMessage(request).errors, ...validateMessage(response).errors];
  const reject = (condition, reason) => { if (condition) errors.push(reason); };
  if (errors.length) return { valid: false, errors };
  reject(request.request_id !== response.request_id, 'request_id mismatch');
  if (request.type === 'negotiate') {
    reject(response.type !== 'negotiated' || request.instance_id !== response.instance_id, 'negotiation target mismatch');
    reject(response.selected_version !== null && !request.supported_versions.includes(response.selected_version), 'unoffered version selected');
  } else if (request.type === 'request') {
    reject(!['response', 'error'].includes(response.type), 'expected response or error');
    reject(request.operation !== response.operation || request.account_id !== response.account_id, 'operation or account mismatch');
    if (errors.length) return { valid: false, errors };
    if (response.type === 'response') {
      const body = request.body;
      const result = response.result;
      const expectedSnapshot = body.snapshot_id ?? body.continuation?.snapshot_id;
      if (expectedSnapshot && ['diff.read', 'diff.files', 'conversation.read', 'conversations.list', 'projects.list', 'sessions.list'].includes(request.operation)) reject(expectedSnapshot !== (result.snapshot_id ?? result.page?.snapshot_id), 'snapshot mismatch');
      if (request.operation === 'diff.read') reject(body.file_id !== result.file_id || body.offset_bytes !== result.offset_bytes, 'file or byte offset mismatch');
      if (result.page && !body.continuation) reject(result.page.offset !== 0, 'initial page starts after zero');
      if (request.operation === 'conversations.list') {
        for (const item of result.items) reject(item.ref.instance_id !== body.instance_id || item.ref.kind !== body.kind, 'conversation catalog scope mismatch');
      }
      if (request.operation === 'projects.list') {
        for (const item of result.items) reject(item.instance_id !== body.instance_id, 'project instance mismatch');
      }
      if ('expected_revision' in body) reject(result.revision !== body.expected_revision + 1, 'mutation revision mismatch');
      if (request.operation === 'account.get') reject(result.account_id !== request.account_id, 'account result mismatch');
    }
  } else if (request.type === 'events.request') {
    if (response.type === 'error') {
      reject(response.operation !== 'events.read' || response.account_id !== request.account_id, 'event error mismatch');
      return { valid: errors.length === 0, errors };
    }
    reject(response.type !== 'events.page' || response.account_id !== request.account_id, 'event response mismatch');
    if (response.type === 'events.page' && !response.reset) {
      reject(request.stream_id !== response.stream_id || request.after_sequence !== response.after_sequence, 'event resume mismatch');
    }
  } else reject(true, 'not a request');
  return { valid: errors.length === 0, errors };
}

/** Adjacent catalog/transcript pages; callers retain identities from all earlier pages. */
export function validatePageContinuation(previous, next) {
  const errors = [...validateMessage(previous).errors, ...validateMessage(next).errors];
  if (errors.length) return { valid: false, errors };
  const a = previous.result?.page;
  const b = next.result?.page;
  if (!a || !b || previous.type !== 'response' || next.type !== 'response') return { valid: false, errors: ['expected page responses'] };
  for (const field of ['snapshot_id', 'revision', 'observed_at', 'expires_at', 'export_policy_revision', 'total']) {
    if (a[field] !== b[field]) errors.push(`page ${field} changed`);
  }
  if (previous.account_id !== next.account_id || previous.operation !== next.operation) errors.push('page scope changed');
  if (a.next_cursor === null || b.offset !== a.offset + previous.result.items.length) errors.push('page continuation gap');
  const identity = (item) => item.message_id ?? item.file_id ?? item.session_id ?? item.project_id ?? item.ref?.conversation_id;
  const seen = new Set(previous.result.items.map(identity));
  if (next.result.items.some((item) => seen.has(identity(item)))) errors.push('repeated page identity');
  return { valid: errors.length === 0, errors };
}
