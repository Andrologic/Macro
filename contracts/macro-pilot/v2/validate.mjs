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
const fileCapability = operation => operation.startsWith('attachment.') ? 'attachment-transfer-1' : ['conversation.send.attachments','conversation.send.status'].includes(operation) ? 'conversation-attachments-1' : ['conversation.files.list','conversation.file.capture','conversation.file.read'].includes(operation) ? 'conversation-files-1' : null;
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
  if (['negotiate', 'negotiated', 'poll'].includes(message.type)) {
    reject(message.type === 'negotiated' && !message.instance_id && (message.capabilities ?? []).length > 0, 'account cannot select instance capabilities');
    reject((message.capabilities ?? []).includes('task-actions-1') && !(message.capabilities ?? []).includes('task-details-1'), 'task actions require details capability');
    reject((message.capabilities ?? []).includes('conversation-history-1') && !(message.capabilities ?? []).includes('conversations-1'), 'conversation history requires conversations capability');
  }
  if (['negotiate','negotiated','poll','delivery'].includes(message.type)) reject((message.capabilities ?? []).includes('conversation-interactions-1') && !(message.capabilities ?? []).includes('conversations-1'), 'interactions require conversations capability');
  if (message.type === 'delivery') reject(['conversation.interactions','conversation.interact'].includes(message.request.operation) && !(message.capabilities ?? []).includes('conversation-interactions-1'), 'unattested interactions capability');
  if (['negotiate','negotiated','poll','delivery'].includes(message.type)) reject((message.capabilities ?? []).includes('conversation-models-1') && !(message.capabilities ?? []).includes('conversation-interactions-1'), 'models require interactions capability');
  if (message.type === 'delivery') reject(message.request.operation === 'conversation.interact' && message.request.body.action === 'select_model' && !(message.capabilities ?? []).includes('conversation-models-1'), 'unattested models capability');
  if (message.type === 'request' && message.operation === 'conversation.interact') {
    const b = message.body;
    reject(b.action === 'answer' ? !b.assistant_message_id || !b.answers || 'generation_id' in b || 'selection' in b
      : b.action === 'stop' ? !b.generation_id || 'answers' in b || 'assistant_message_id' in b || 'selection' in b
      : !b.selection || 'answers' in b || 'assistant_message_id' in b || 'generation_id' in b, 'interaction payload mismatch');
    if (b.answers) reject(new Set(b.answers.map(a => a.step_id)).size !== b.answers.length || b.answers.some(a => !a.answer.trim()), 'invalid answers');
  }
  if (message.type === 'response' && message.operation === 'conversation.interactions') {
    const r = message.result;
    reject(r.actions.includes('answer') && r.question === null || r.actions.includes('stop') && r.generation_id === null, 'missing action target');
    reject(r.actions.includes('select_model') && (!r.model_catalog || r.question !== null || r.generation_id !== null), 'model selection unavailable');
    if (r.model_catalog) {
      const models = r.model_catalog.models;
      reject(new Set(models.map(m => JSON.stringify([m.provider_id,m.model_id]))).size !== models.length, 'duplicate models');
      const selected = r.model_catalog.selection;
      if (selected) reject(!models.some(m => m.provider_id === selected.provider_id && m.model_id === selected.model_id && (selected.reasoning_effort === null || m.reasoning_efforts.includes(selected.reasoning_effort))), 'selection outside model catalog');
    }
    if (r.question) reject(new Set(r.question.steps.map(s => s.step_id)).size !== r.question.steps.length, 'duplicate questions');
  }
  if (message.type === 'accepted') reject(message.exchange_id !== message.request_id, 'exchange identity mismatch');
  if (message.type === 'delivery') {
    reject(message.request_id !== message.request.request_id || message.account_id !== message.request.account_id, 'delivery correlation mismatch');
    const scope = message.request.body.ref ?? message.request.body;
    reject(scope.instance_id !== message.instance_id, 'delivery instance mismatch');
    reject(message.request.body.consistency === 'network-reliability-1' && !(message.capabilities ?? []).includes('network-reliability-1'), 'unattested reliability selection');
    reject(isConversationOperation(message.request.operation) && !(message.capabilities ?? []).includes('conversations-1'), 'unattested conversations capability');
    reject(message.request.body.direction === 'backward' && !(message.capabilities ?? []).includes('conversation-history-1'), 'unattested history capability');
    reject(!validateMessage(message.request).valid, 'invalid delivered request');
  }
  if (message.type === 'delivery') {
    const capability = {'instance.telemetry': 'host-telemetry-1', 'project.icon': 'project-icons-1'}[message.request.operation];
    reject(capability && !(message.capabilities ?? []).includes(capability), 'unattested machine capability');
  }
  if (message.type === 'response' && ['instance.telemetry', 'project.icon'].includes(message.operation)) {
    const r = message.result;
    const lifetime = Date.parse(r.expires_at) - Date.parse(r.observed_at);
    reject(lifetime <= 0 || lifetime > (message.operation === 'instance.telemetry' ? 5000 : 300000), 'machine resource lifetime');
    if (message.operation === 'instance.telemetry') {
      reject(r.availability === 'available' ? r.reason !== null || r.cpu_percent === null || r.memory_used_bytes === null || r.memory_total_bytes === null || r.memory_total_bytes <= 0 || r.memory_used_bytes > r.memory_total_bytes : r.reason === null || r.cpu_percent !== null || r.memory_used_bytes !== null || r.memory_total_bytes !== null, 'telemetry availability mismatch');
    } else {
      reject((r.availability === 'available') !== (r.icon !== null), 'icon availability mismatch');
      if (r.icon) {
        const base64 = r.icon.data_base64;
        const size = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
        reject(size !== r.icon.size_bytes, 'icon byte size mismatch');
        const decoded = atob(base64);
        reject(btoa(decoded) !== base64, 'noncanonical icon base64');
        const b = Uint8Array.from(decoded, char => char.charCodeAt(0));
        const signature = r.icon.mime_type === 'image/png' ? b.length >= 8 && [137,80,78,71,13,10,26,10].every((value,index) => b[index] === value)
          : r.icon.mime_type === 'image/jpeg' ? b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255 && b.at(-2) === 255 && b.at(-1) === 217
          : b.length >= 12 && decoded.slice(0,4) === 'RIFF' && decoded.slice(8,12) === 'WEBP' && new DataView(b.buffer).getUint32(4,true) + 8 === b.length;
        reject(!signature, 'icon signature mismatch');

      }
    }
  }
  if (message.type === 'delivery') {
    const capability = fileCapability(message.request.operation);
    reject(capability && (!(message.capabilities ?? []).includes(capability) || !message.authority_binding), 'unattested file authority');
    reject(!capability && 'authority_binding' in message, 'legacy delivery authority extension');
  }
  if (message.type === 'request' && message.operation === 'attachment.chunk') {
    const b = message.body.data_base64;
    const size = b.length / 4 * 3 - (b.endsWith('==') ? 2 : b.endsWith('=') ? 1 : 0);
    reject(size < 1 || size > 65536 || btoa(atob(b)) !== b, 'attachment fragment bounds');
  }
  if (message.type === 'response' && message.operation.startsWith('attachment.')) {
    const r = message.result;
    reject(r.received_bytes > r.total_bytes, 'transfer progress exceeds total');
    reject(['finalized','attached'].includes(r.state) ? r.attachment_id === null || r.received_bytes !== r.total_bytes : r.attachment_id !== null, 'transfer receipt state');
    reject(Date.parse(r.expires_at) - Date.parse(r.observed_at) > 900000, 'transfer lifetime');
  }
  if (message.type === 'response' && message.operation === 'conversation.file.capture') {
    const r = message.result;
    reject(Date.parse(r.expires_at) <= Date.parse(r.observed_at) || Date.parse(r.expires_at) - Date.parse(r.observed_at) > 300000, 'file capture lifetime');
    reject(r.content_state === 'available' ? r.total_bytes === null || r.sha256 === null || r.mime_type === null : r.total_bytes !== null || r.sha256 !== null || r.mime_type !== null, 'file capture availability');
  }
  if (message.type === 'response' && message.operation === 'conversation.file.read') {
    const r = message.result;
    if (r.content_state === 'available') {
      reject(r.data_base64 === null || r.total_bytes === null || r.sha256 === null, 'missing file bytes');
      if (r.data_base64 !== null && r.total_bytes !== null) {
        const b = r.data_base64;
        const size = b.length / 4 * 3 - (b.endsWith('==') ? 2 : b.endsWith('=') ? 1 : 0);
        reject(size > 65536 || btoa(atob(b)) !== b || r.offset_bytes + size > r.total_bytes, 'file fragment bounds');
        reject(r.next_offset_bytes !== (r.offset_bytes + size < r.total_bytes ? r.offset_bytes + size : null), 'file fragment cursor');
      }
    } else reject(r.data_base64 !== null || r.total_bytes !== null || r.sha256 !== null || r.next_offset_bytes !== null, 'unavailable file bytes');
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
    reject(page.direction && message.operation !== 'conversation.window', 'history direction outside window');
    reject((page.next_cursor === null) !== (page.direction === 'backward' ? page.offset === 0 : page.offset + result.items.length === page.total), 'cursor does not match remaining items');
    reject(result.items.length === 0 && page.next_cursor !== null, 'empty nonterminal page');
    const identities = result.items.map((item) => item.hit_id ?? item.trace_id ?? item.artifact_id ?? item.message_id ?? item.file_id ?? item.session_id ?? item.project_id ?? item.ref?.conversation_id ?? item.ref?.task_id);
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
  if (message.type === 'response' && message.operation === 'conversations.catalog') {
    for (const item of message.result.items) {
      reject(item.provider_error !== null && item.attention !== 'error', 'provider diagnosis requires error');
      reject(item.ref.kind === 'implement' && item.mode !== 'Implement', 'Implement mode mismatch');
      reject(item.ref.kind === 'conversation' && item.mode === 'Implement', 'Chat mode mismatch');
    }
  }
  if (message.type === 'response' && message.operation === 'conversations.search') {
    for (const item of message.result.items) reject((item.source === 'message') !== (item.message_id !== null), 'search reference mismatch');
  }
  if (message.type === 'request' && message.operation === 'conversation.action') {
    reject(message.body.ref.kind !== 'conversation', 'Chat action reference required');
    reject((message.body.action === 'rename') !== ('title' in message.body), 'rename title exclusively');
    reject(message.body.action === 'rename' && !message.body.title.trim(), 'empty title');
  }
  if (message.type === 'request' && message.operation === 'conversation.create') reject(message.body.title !== undefined && !message.body.title.trim(), 'empty title');
  if (message.type === 'request' && message.operation === 'conversations.search') reject(!message.body.query.trim(), 'empty search');
  if (message.type === 'request') {
    reject(message.body.known_revision !== undefined && (message.body.consistency !== 'network-reliability-1' || message.body.continuation), 'conditional projects require negotiated initial request');
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
  if (message.type === 'request' && message.operation === 'task.action') {
    reject((message.body.action === 'rename') !== ('title' in message.body), 'rename requires title exclusively');
    reject(message.body.action === 'rename' && !message.body.title.trim(), 'empty title');
  }
  if (message.type === 'response' && ['task.artifact.read', 'conversation.tool.read'].includes(message.operation)) {
    const content = result.content;
    if (content.content_state === 'withheld') reject(result.total_bytes !== 0 || result.offset_bytes !== 0 || result.next_offset_bytes !== null, 'withheld content has bytes');
    else {
      const end = result.offset_bytes + bytes(content.text);
      reject(end > result.total_bytes || result.next_offset_bytes !== (end === result.total_bytes ? null : end), 'content continuation mismatch');
      reject(!content.text.length && result.next_offset_bytes !== null, 'empty chunk');
    }
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
    reject((response.capabilities ?? []).some(cap => !(request.capabilities ?? []).includes(cap)), 'unoffered capability selected');
    reject(response.selected_version !== null && !request.supported_versions.includes(response.selected_version), 'unoffered version selected');
  } else if (request.type === 'request') {
    reject(!['response', 'error'].includes(response.type), 'expected response or error');
    reject(request.operation !== response.operation || request.account_id !== response.account_id, 'operation or account mismatch');
    if (errors.length) return { valid: false, errors };
    if (response.type === 'response') {
      const body = request.body;
      const result = response.result;
      const expectedSnapshot = body.snapshot_id ?? body.continuation?.snapshot_id;
      if (expectedSnapshot && ['diff.read', 'diff.files', 'conversation.read', 'conversations.list', 'projects.list', 'sessions.list', 'task.cards.list', 'task.artifacts.list', 'task.artifact.read', 'conversation.tools.list', 'conversation.tool.read', 'conversations.catalog', 'conversations.search', 'conversation.window', 'conversation.files.list', 'conversation.file.read'].includes(request.operation)) reject(expectedSnapshot !== (result.snapshot_id ?? result.page?.snapshot_id), 'snapshot mismatch');
      if (request.operation === 'diff.read') reject(body.file_id !== result.file_id || body.offset_bytes !== result.offset_bytes, 'file or byte offset mismatch');
      if (request.operation === 'conversation.window') {
        reject((body.direction ?? null) !== (result.page.direction ?? null), 'window direction mismatch');
        if (body.direction === 'backward' && !body.continuation && !body.message_id) reject(result.page.offset + result.items.length !== result.page.total, 'initial window must end at latest message');
      }
      if (result.page && !body.continuation && !(request.operation === 'conversation.window' && (body.message_id || body.direction === 'backward'))) reject(result.page.offset !== 0, 'initial page starts after zero');
      if (['conversations.catalog', 'conversations.search'].includes(request.operation)) {
        for (const item of result.items) reject(item.ref.instance_id !== body.instance_id || item.ref.kind !== body.kind, 'conversation catalog scope mismatch');
      }
      if (request.operation === 'conversation.action') reject(['instance_id', 'kind', 'conversation_id'].some(key => body.ref[key] !== result.ref[key]), 'action reference mismatch');
      if (request.operation === 'conversation.create') reject(result.ref.instance_id !== body.instance_id || result.ref.kind !== 'conversation', 'created reference mismatch');
      if (request.operation === 'conversations.list') {
        for (const item of result.items) {
          const enhanced = body.consistency === 'network-reliability-1';
          reject(enhanced !== ('content_revision' in item && 'mode' in item && 'provider_error' in item), 'summary selection mismatch');
          reject(!enhanced && ('content_revision' in item || 'mode' in item || 'provider_error' in item), 'legacy summary extension');
          reject(item.provider_error != null && item.activity !== 'error', 'provider diagnosis requires error');
        }
        for (const item of result.items) reject(item.ref.instance_id !== body.instance_id || item.ref.kind !== body.kind, 'conversation catalog scope mismatch');
      }
      if (request.operation === 'projects.list') {
        if (result.not_modified) reject(body.consistency !== 'network-reliability-1' || body.known_revision !== result.revision || body.continuation, 'invalid conditional response');
        for (const item of result.items ?? []) reject(item.instance_id !== body.instance_id, 'project instance mismatch');
      }
      if (request.operation === 'conversation.interactions') reject(Object.keys(body.ref).length !== Object.keys(result.ref).length || Object.keys(body.ref).some(key => body.ref[key] !== result.ref[key]), 'interaction reference mismatch');
      if (request.operation === 'task.get') reject(['instance_id', 'workspace_id', 'task_id'].some(key => body.ref[key] !== result.ref[key]), 'task reference mismatch');
      if (request.operation === 'task.cards.list') for (const item of result.items) reject(item.ref.instance_id !== body.instance_id, 'task catalog instance mismatch');
      if (['task.artifact.read', 'conversation.tool.read', 'conversations.catalog', 'conversations.search', 'conversation.window'].includes(request.operation)) reject(body.item_id !== result.item_id || body.offset_bytes !== result.offset_bytes, 'item or offset mismatch');
      if ('expected_revision' in body && request.operation !== 'conversation.send.attachments') reject(result.revision !== body.expected_revision + 1, 'mutation revision mismatch');
      if (request.operation === 'sessions.list') reject(body.include_last_seen !== true && result.items.some(item => 'last_seen_at' in item), 'unrequested activity projection');
      if (request.operation === 'instance.telemetry') reject(result.instance_id !== body.instance_id, 'telemetry instance mismatch');
      if (request.operation === 'project.icon') reject(Object.keys(body.ref).some(key => body.ref[key] !== result.ref[key]), 'icon project mismatch');
      if (fileCapability(request.operation) && request.operation !== 'conversation.files.list') {
        reject(Object.keys(body.ref).some(key => result.ref[key] !== body.ref[key]) || Object.keys(body.ref).length !== Object.keys(result.ref).length, 'file reference mismatch');
        if ('transfer_id' in body) reject(body.transfer_id !== result.transfer_id, 'transfer identity mismatch');
        if ('intent_id' in body) reject(body.intent_id !== result.intent_id, 'file intent mismatch');
        if ('file_id' in body) reject(body.file_id !== result.file_id, 'file identity mismatch');
        if ('snapshot_id' in body) reject(body.snapshot_id !== result.snapshot_id, 'file capture identity mismatch');
        if ('offset_bytes' in body && request.operation === 'conversation.file.read') reject(body.offset_bytes !== result.offset_bytes, 'file offset mismatch');
        if (request.operation === 'conversation.send.attachments') reject(JSON.stringify(body.attachment_ids) !== JSON.stringify(result.attachment_ids), 'attachment selection mismatch');
      }
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
  for (const field of ['snapshot_id', 'revision', 'observed_at', 'expires_at', 'export_policy_revision', 'total', 'direction']) {
    if (a[field] !== b[field]) errors.push(`page ${field} changed`);
  }
  if (previous.account_id !== next.account_id || previous.operation !== next.operation) errors.push('page scope changed');
  if (a.next_cursor === null || (a.direction === 'backward' ? b.offset + next.result.items.length !== a.offset : b.offset !== a.offset + previous.result.items.length)) errors.push('page continuation gap');
  const identity = (item) => item.hit_id ?? item.trace_id ?? item.artifact_id ?? item.message_id ?? item.file_id ?? item.session_id ?? item.project_id ?? item.ref?.conversation_id ?? item.ref?.task_id;
  const seen = new Set(previous.result.items.map(identity));
  if (next.result.items.some((item) => seen.has(identity(item)))) errors.push('repeated page identity');
  return { valid: errors.length === 0, errors };
}

export const isConversationOperation = operation => ['conversations.catalog', 'conversations.search', 'conversation.window', 'conversation.acknowledge', 'conversation.action', 'conversation.create', 'conversation.interactions', 'conversation.interact'].includes(operation);

/** Synchronous validators prove shape and correlation only. Call this async
 * check before accepting or emitting a complete resource with embedded bytes.
 * Uses Web Crypto and the same API in browsers, Bun and Node with Web Crypto. */
export async function validateResourceIntegrity(message) {
  const validation = validateMessage(message);
  if (!validation.valid) return validation;
  const payload = message.type === 'delivery.result' ? message.response : message.type === 'delivery' ? message.request : message;
  let expected, encoded;
  if (payload.type === 'response' && payload.operation === 'project.icon' && payload.result.icon) {
    expected = payload.result.icon.sha256; encoded = payload.result.icon.data_base64;
  } else if (payload.type === 'request' && payload.operation === 'attachment.chunk') {
    expected = payload.body.sha256; encoded = payload.body.data_base64;
  } else if (payload.type === 'response' && payload.operation === 'conversation.file.read' && payload.result.content_state === 'available' &&
    payload.result.offset_bytes === 0 && payload.result.next_offset_bytes === null) {
    expected = payload.result.sha256; encoded = payload.result.data_base64;
  }
  if (encoded === undefined) return validation;
  try {
    const raw = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const actual = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', raw)), byte => byte.toString(16).padStart(2, '0')).join('');
    return actual === expected ? validation : { valid: false, errors: ['resource sha256 mismatch'] };
  } catch { return { valid: false, errors: ['resource integrity unavailable'] }; }
}

/** After collecting every bounded file fragment, verify the hash of the full
 * exported bytes before display or saving. The capture must already have passed
 * exchange, current authorization, scope and freshness checks. */
export async function validateCapturedFileBytes(capture, raw) {
  if (!capture || capture.content_state !== 'available' || !(raw instanceof Uint8Array) || raw.length > 2097152 ||
    capture.total_bytes !== raw.length || !/^[a-f0-9]{64}$/.test(capture.sha256)) return false;
  try {
    const actual = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(raw))), byte => byte.toString(16).padStart(2, '0')).join('');
    return actual === capture.sha256;
  } catch { return false; }
}
