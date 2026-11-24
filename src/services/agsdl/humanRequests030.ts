import type { HumanScope030 } from '../../types/generated/ipc/HumanScope030';
import type { HumanContinuation030 } from '../../types/generated/ipc/HumanContinuation030';
import type { HumanPage030 } from '../../types/generated/ipc/HumanPage030';
import type { PublicHumanRequest030 } from '../../types/generated/ipc/PublicHumanRequest030';
import type { HumanAnswer030 } from '../../types/generated/ipc/HumanAnswer030';

export type ExecutionHumanRequestView =
  | { kind: 'approval'; title: string; description?: string; message: string; choices: readonly { value: string; label: string }[] }
  | { kind: 'plan'; title: string; description?: string; message: string }
  | { kind: 'actionApproval'; title: string; description?: string; message: string }
  | { kind: 'question'; title: string; description?: string; message: string };
export type ExecutionHumanAnswer =
  | { kind: 'approval'; choice: string; comment: string }
  | { kind: 'plan'; approve: boolean; comment: string }
  | { kind: 'decision'; decision: 'yes' | 'no'; comment: string }
  | { kind: 'question'; answer: string };

/** Display only; native admission and response checks own authorization. */
export function nativeCommandSummary030(raw: string): { command: string; file: string; cwd: string } | null {
  try {
    const request = JSON.parse(raw)?.nativeRequest;
    const params = request?.params;
    const files = params?.additionalPermissions?.fileSystem?.write;
    if (request?.method !== 'item/commandExecution/requestApproval' || params?.kind !== 'command' ||
        typeof params.command !== 'string' || typeof params.cwd !== 'string' ||
        !Array.isArray(files) || files.length !== 1 || typeof files[0] !== 'string') return null;
    return { command: params.command, file: files[0], cwd: params.cwd };
  } catch { return null; }
}

function visibleControls(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char => {
    const code = char.codePointAt(0)!.toString(16);
    return code.length > 4 ? '\\u{' + code + '}' : '\\u' + code.padStart(4, '0');
  });
}

const MCP_ARGUMENT_PREVIEW_LIMIT = 4096;
const MCP_LABEL_LIMIT = 256;
const NATIVE_JSON_DEPTH_LIMIT = 128;
const argumentEncoder = new TextEncoder();

type JsonSpan = { start: number; end: number };
type JsonFields = { readonly [key: string]: JsonFields | true };

const mcpApprovalFields: JsonFields = {
  nativeRequest: { method: true, params: { server: true, tool: true, arguments: true } },
};
// JSON can encode each character of a selected key as a six-character escape.
const maxSelectedKeySpan = 'nativeRequest'.length * 6 + 2;

/** Validate the envelope while retaining only spans used by the preview. */
function nativeJsonSpans(raw: string) {
  const spans = new Map<string, JsonSpan>();
  const whitespace = /[ \t\r\n]*/y;
  // eslint-disable-next-line no-control-regex -- JSON forbids raw ASCII controls in strings.
  const stringTokens = /["\\\u0000-\u001f]/g;
  const escape = /(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y;
  const primitive = /(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/y;
  let at = 0;

  const invalid = (): never => { throw new Error('Invalid native JSON'); };
  const skipWhitespace = () => {
    whitespace.lastIndex = at;
    whitespace.test(raw);
    at = whitespace.lastIndex;
  };
  const consume = (token: string) => {
    if (raw[at] !== token) return false;
    at++;
    return true;
  };
  const skipString = () => {
    stringTokens.lastIndex = at + 1;
    for (let token = stringTokens.exec(raw); token; token = stringTokens.exec(raw)) {
      if (token[0] === '"') {
        at = stringTokens.lastIndex;
        return;
      }
      if (token[0] !== '\\') invalid();
      escape.lastIndex = stringTokens.lastIndex;
      if (!escape.test(raw)) invalid();
      stringTokens.lastIndex = escape.lastIndex;
    }
    invalid();
  };

  function scanValue(depth: number, fields?: JsonFields) {
    if (depth > NATIVE_JSON_DEPTH_LIMIT) invalid();
    if (fields && raw[at] !== '{') invalid();
    switch (raw[at]) {
      case '{': scanObject(depth, fields); return;
      case '[':
        at++;
        skipWhitespace();
        if (consume(']')) return;
        do {
          skipWhitespace();
          scanValue(depth + 1);
          skipWhitespace();
        } while (consume(','));
        if (!consume(']')) invalid();
        return;
      case '"': skipString(); return;
      default:
        primitive.lastIndex = at;
        if (!primitive.test(raw)) invalid();
        at = primitive.lastIndex;
    }
  }

  function scanObject(depth: number, fields?: JsonFields) {
    at++;
    skipWhitespace();
    if (consume('}')) return;
    const seen = fields && new Set<string>();
    do {
      skipWhitespace();
      if (raw[at] !== '"') invalid();
      const keyStart = at;
      skipString();
      const key: string | undefined = fields && at - keyStart <= maxSelectedKeySpan
        ? JSON.parse(raw.slice(keyStart, at)) : undefined;
      const selected = fields && key !== undefined && Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (selected && key !== undefined) {
        if (seen?.has(key)) invalid();
        seen?.add(key);
      }
      skipWhitespace();
      if (!consume(':')) invalid();
      skipWhitespace();
      const start = at;
      scanValue(depth + 1, selected === true ? undefined : selected);
      if (selected === true && key !== undefined) spans.set(key, { start, end: at });
      skipWhitespace();
    } while (consume(','));
    if (!consume('}')) invalid();
  }

  skipWhitespace();
  scanValue(0, mcpApprovalFields);
  skipWhitespace();
  if (at !== raw.length) invalid();
  return spans;
}

export function mcpApprovalLabel030(text: string): string {
  const label = visibleControls(text.slice(0, MCP_LABEL_LIMIT));
  if (text.length <= MCP_LABEL_LIMIT && label.length <= MCP_LABEL_LIMIT) return label;
  return label.slice(0, MCP_LABEL_LIMIT - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

/** Decode a bounded prefix of a validated JSON string without cutting an escape. */
function readMcpLabel(raw: string, span: JsonSpan | undefined): string | undefined {
  if (!span || raw[span.start] !== '"') return undefined;
  const end = span.end - 1;
  let at = span.start + 1;
  // Read one extra code unit so the display can indicate truncation.
  for (let length = 0; at < end && length <= MCP_LABEL_LIMIT; length++) {
    if (raw[at] !== '\\') at++;
    else at += raw[at + 1] === 'u' ? 6 : 2;
  }
  return mcpApprovalLabel030(JSON.parse(raw.slice(span.start, at) + '"'));
}

export function nativeMcpSummary030(raw: string) {
  try {
    const fields = nativeJsonSpans(raw);
    if (readMcpLabel(raw, fields.get('method')) !== 'mcp/tool/requestApproval') return null;
    const server = readMcpLabel(raw, fields.get('server'));
    const tool = readMcpLabel(raw, fields.get('tool'));
    const span = fields.get('arguments');
    if (server === undefined || tool === undefined || !span || raw[span.start] !== '{') return null;

    // A UTF-8 prefix cannot contain more UTF-16 code units than bytes.
    const end = Math.min(span.end, span.start + MCP_ARGUMENT_PREVIEW_LIMIT + 1);
    const bytes = argumentEncoder.encode(raw.slice(span.start, end));
    const partial = end < span.end || bytes.length > MCP_ARGUMENT_PREVIEW_LIMIT;
    const preview = visibleControls(new TextDecoder().decode(bytes.subarray(0, MCP_ARGUMENT_PREVIEW_LIMIT), {
      stream: partial,
    }));
    const truncated = partial || preview.length > MCP_ARGUMENT_PREVIEW_LIMIT;
    // Avoid splitting an astral character when control escapes expand the preview.
    const prefix = preview.slice(0, MCP_ARGUMENT_PREVIEW_LIMIT).replace(/[\uD800-\uDBFF]$/, '');
    return {
      server,
      tool,
      preview: prefix + (truncated ? '…' : ''),
      truncated,
      fullArguments: () => visibleControls(raw.slice(span.start, span.end)),
    };
  } catch { return null; }
}

export const sameHumanScope030 = (a: HumanScope030, b: HumanScope030) => a.systemStartId === b.systemStartId &&
  a.source.revision === b.source.revision && a.source.sourceSha256 === b.source.sourceSha256 &&
  a.source.owner.projectId === b.source.owner.projectId && a.source.owner.planId === b.source.owner.planId &&
  a.source.owner.branch === b.source.owner.branch;

/** Read an entire immutable page series before publishing any result. A run
 * change yields no result, and a native conflict rejects the entire series. */
export async function loadHumanRequests030(scope: HumanScope030, read: (scope: HumanScope030, page?: HumanContinuation030) => Promise<HumanPage030>, current: (scope: HumanScope030) => boolean): Promise<HumanPage030 | undefined> {
  const captured = structuredClone(scope);
  const requests: PublicHumanRequest030[] = [];
  const ids = new Set<string>();
  let next: HumanContinuation030 | undefined;
  let cursor: string | undefined;
  let total: string | undefined;
  let offset = 0;
  do {
    if (!current(captured)) return undefined;
    const page = await read(structuredClone(captured), next && structuredClone(next));
    if (!current(captured)) return undefined;
    if (!sameHumanScope030(page.scope, captured) || (cursor !== undefined && page.cursor !== cursor) ||
        !/^(0|[1-9][0-9]*)$/.test(page.total) || (total !== undefined && page.total !== total) ||
        page.requests.length > 64 || (offset > 0 && !page.requests.length)) throw new Error('Invalid human projection page');
    cursor = page.cursor; total = page.total;
    for (const request of page.requests) {
      if (!request.id || ids.has(request.id)) throw new Error('Duplicate human request');
      ids.add(request.id); requests.push(request);
    }
    next = page.nextPage ?? undefined;
    if (next && (!sameHumanScope030(next.scope, captured) || next.cursor !== cursor || next.offset !== offset + 64 || page.requests.length !== 64)) throw new Error('Invalid human projection continuation');
    offset += 64;
  } while (next);
  if (BigInt(total!) !== BigInt(requests.length)) throw new Error('Incomplete human projection');
  return { scope: captured, cursor: cursor!, total: total!, requests, nextPage: null };
}

/** Labels for plan/question come from the UI locale, not native identity. */
export function humanRequestView030(request: Pick<PublicHumanRequest030, 'content'>, labels: { plan: string; question: string }): ExecutionHumanRequestView {
  const content = request.content;
  if (content.kind === 'approval') return { kind: 'approval', title: content.title, description: content.description, message: content.message, choices: content.choices.map(value => ({ value, label: value })) };
  if (content.kind === 'plan') return { kind: 'plan', title: labels.plan, message: content.plan };
  return { kind: 'question', title: labels.question, description: content.expectedResponse, message: content.question };
}

/** Questions are intentionally excluded: the native contract has not attested
 * whether expectedResponse describes text or a JSON schema. */
export function humanAnswer030(request: PublicHumanRequest030, answer: ExecutionHumanAnswer): HumanAnswer030 {
  if (request.status !== 'open') throw new Error('Human request is not open');
  if (request.content.kind === 'approval' && answer.kind === 'approval' && request.content.choices.includes(answer.choice))
    return { kind: 'approval', choice: answer.choice, comment: answer.comment === '' ? null : answer.comment };
  if (request.content.kind === 'plan' && answer.kind === 'plan')
    return { kind: 'plan', accept: answer.approve, comment: answer.comment === '' ? null : answer.comment };
  throw new Error('Human answer is not supported by the attested request');
}

/** Preserve an already-attested exact JSON answer, without parsing or rewriting it. */
export function exactQuestionAnswer030(request: PublicHumanRequest030, answerJson: string): HumanAnswer030 {
  if (request.status !== 'open' || request.content.kind !== 'question') throw new Error('Human request is not an open question');
  return { kind: 'question', answerJson };
}

// Product 0.3 contract. Historical adapters above remain read-only consumers.
import type {
  RunActionResult030, RunHumanAnswer030, RunHumanClock030,
  RunHumanReceipt030, RunHumanRequest030, RunHumanSubmission030,
} from '../../types/agsdlRunUi030';

export type SubmitHuman030 = (input: RunHumanSubmission030) => Promise<RunActionResult030<'flowChoice' | 'actionApproval' | 'plan' | 'question'>>;
export type ReadHuman030 = (target: Pick<RunHumanSubmission030, 'scope' | 'requestId'>) => Promise<RunHumanRequest030>;
export type HumanDraftStorage030 = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface HumanFormDraft030 { choice: string | null; text: string }

/** Revision deliberately excluded. A refresh cannot erase a person's draft. */
export function humanRequestKey030(request: Pick<RunHumanRequest030, 'scope' | 'id'>): string {
  const { source, systemStartId } = request.scope;
  return JSON.stringify([source.owner.projectId, source.owner.planId, source.owner.branch,
    source.revision, source.sourceSha256, systemStartId, request.id]);
}

/** No browser clock, numeric rounding, or inferred expiration. */
export function humanRemainingMs030(clock: RunHumanClock030): string | null {
  if (clock.timeoutMs === null) return null;
  const remaining = BigInt(clock.openedAtMs) + BigInt(clock.timeoutMs) - BigInt(clock.observedAtMs);
  return (remaining > 0n ? remaining : 0n).toString();
}

export function humanDuration030(ms: string): string {
  const seconds = (BigInt(ms) + 999n) / 1000n;
  const tail = (seconds % 60n).toString().padStart(2, '0');
  return `${seconds / 60n}:${tail}`;
}

export function runHumanView030(request: RunHumanRequest030, labels: { plan: string; question: string; unknown: string }): ExecutionHumanRequestView {
  const content = request.content;
  switch (content.kind) {
    case 'flowChoice': return { kind: 'approval', title: content.title, description: content.description,
      message: content.messageJson, choices: content.choices.map(value => ({ value, label: value })) };
    case 'actionApproval': return { kind: 'actionApproval', title: visibleControls(content.title), message: content.actionJson };
    case 'plan': return { kind: 'plan', title: labels.plan, message: content.plan };
    case 'question': return { kind: 'question', title: labels.question, message: content.question, description: content.expectedResponse };
    case 'unclassified': return humanRequestView030({ content: content.content }, labels);
  }
}

/** No default answer, trimming, null comment, yes/no conversion, or schema inference. */
export function runHumanAnswer030(request: RunHumanRequest030, answer: ExecutionHumanAnswer): RunHumanAnswer030 {
  if (request.state.kind !== 'open') throw new Error('REQUEST_CLOSED');
  const content = request.content;
  if (content.kind === 'flowChoice' && answer.kind === 'approval' && content.choices.includes(answer.choice))
    return { kind: 'approval', choice: answer.choice, comment: answer.comment };
  if (content.kind === 'actionApproval' && answer.kind === 'decision') return answer;
  if (content.kind === 'plan' && answer.kind === 'plan')
    return { kind: 'decision', decision: answer.approve ? 'yes' : 'no', comment: answer.comment };
  if (content.kind === 'question' && content.answerContract.kind === 'available' && answer.kind === 'question')
    return { kind: 'question', answerJson: answer.answer };
  throw new Error('INPUT_CONSTRAINT');
}

export interface HumanSendOutcome030 {
  result: Awaited<ReturnType<SubmitHuman030>> | null;
  current: RunHumanRequest030 | null;
  readFailed: boolean;
}

/** The injected native transport owns validation and durable idempotence. The
 * local latch prevents resubmission after remount/reload or lost acknowledgement.
 * Readback alone never replays an answer. Use one client for the visible scope. */
export function createHumanRequestClient030({ submit, read, storage }: {
  submit: SubmitHuman030; read: ReadHuman030; storage: HumanDraftStorage030;
}) {
  const pending = new Map<string, Promise<HumanSendOutcome030>>();
  // The shared client outlives views for individual instances. Apply readbacks
  // before filtering by instance, since a read can change the request's links.
  const readbacks = new Map<string, RunHumanRequest030>();
  const listeners = new Set<() => void>();
  let readbackVersion = 0;
  const readbackKey = (request: RunHumanRequest030, captureKey?: string) =>
    JSON.stringify([captureKey ?? null, humanRequestKey030(request)]);
  const currentRequest = (request: RunHumanRequest030, captureKey?: string) => {
    const cached = readbacks.get(readbackKey(request, captureKey));
    if (!cached || BigInt(request.revision) > BigInt(cached.revision)) return request;
    if (request.revision === cached.revision && request.clock.kind === 'available' &&
        (cached.clock.kind !== 'available' || BigInt(request.clock.value.observedAtMs) > BigInt(cached.clock.value.observedAtMs))) {
      return { ...cached, clock: request.clock };
    }
    return cached;
  };
  const retainReadback = (request: RunHumanRequest030, captureKey?: string) => {
    const current = currentRequest(request, captureKey);
    if (BigInt(current.revision) > BigInt(request.revision) ||
        (current.revision === request.revision && current.state.kind !== 'open' && request.state.kind === 'open')) return current;
    readbacks.set(readbackKey(request, captureKey), request);
    readbackVersion++;
    listeners.forEach(listener => listener());
    return request;
  };
  const key = (request: RunHumanRequest030, suffix: string) => `macro.human030.${suffix}.${humanRequestKey030(request)}`;
  const draftRecord = (request: RunHumanRequest030): Record<string, unknown> => {
    const raw = storage.getItem(key(request, 'draft'));
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    // A stored draft that is not an object may have held a revision floor.
    // Refuse to treat it as empty: the caller keeps sending locked.
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid retained draft');
    return value as Record<string, unknown>;
  };
  const minimumRevision = (request: RunHumanRequest030): string | null => {
    const minimum = draftRecord(request).minimumRevision;
    if (minimum === undefined) return null;
    if (typeof minimum !== 'string' || !/^(0|[1-9][0-9]*)$/.test(minimum)) throw new Error('Invalid retained revision');
    return minimum;
  };
  const stale = (request: RunHumanRequest030) => {
    const minimum = minimumRevision(request);
    return minimum !== null && BigInt(request.revision) < BigInt(minimum);
  };
  const retainMinimum = (request: RunHumanRequest030, revision: string) => {
    const previous = minimumRevision(request);
    const minimum = previous !== null && BigInt(previous) > BigInt(revision) ? previous : revision;
    storage.setItem(key(request, 'draft'), JSON.stringify({ ...draftRecord(request), minimumRevision: minimum }));
  };
  const readCurrent = async (request: RunHumanRequest030, captureKey?: string) => {
    const current = await read({ scope: request.scope, requestId: request.id });
    if (humanRequestKey030(current) !== humanRequestKey030(request)) throw new Error('CORRELATION');
    if (BigInt(current.revision) < BigInt(currentRequest(request, captureKey).revision) || stale(current))
      throw new Error('REVISION_CONFLICT');
    return current;
  };
  return {
    currentRequest,
    readbackVersion: () => readbackVersion,
    subscribeReadbacks(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    loadDraft(request: RunHumanRequest030): HumanFormDraft030 | null {
      const raw = storage.getItem(key(request, 'draft'));
      if (!raw) return null;
      try {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== 'object' || value === null || !('text' in value) || !('choice' in value)) return null;
        if (typeof value.text !== 'string' || !(value.choice === null || typeof value.choice === 'string')) return null;
        return { text: value.text, choice: value.choice };
      } catch { return null; }
    },
    saveDraft(request: RunHumanRequest030, draft: HumanFormDraft030) {
      const minimum = minimumRevision(request);
      storage.setItem(key(request, 'draft'), JSON.stringify({ ...draft, ...(minimum === null ? {} : { minimumRevision: minimum }) }));
    },
    stale,
    blocked(request: RunHumanRequest030) { return storage.getItem(key(request, 'attempt')) !== null; },
    async refresh(request: RunHumanRequest030, captureKey?: string) {
      const current = await readCurrent(request, captureKey);
      if (storage.getItem(key(request, 'attempt')) === 'refused') storage.removeItem(key(request, 'attempt'));
      return retainReadback(current, captureKey);
    },
    send(request: RunHumanRequest030, answer: ExecutionHumanAnswer, captureKey?: string): Promise<HumanSendOutcome030> {
      const identity = humanRequestKey030(request);
      const inflight = pending.get(identity);
      if (inflight) return inflight;
      const input: RunHumanSubmission030 = { scope: request.scope, requestId: request.id,
        expectedRevision: request.revision, answer: runHumanAnswer030(request, answer) };
      // Persist before calling transport. Failure to persist must prevent sending.
      const blocked = storage.getItem(key(request, 'attempt')) !== null || stale(request) ||
        currentRequest(request, captureKey) !== request;
      if (!blocked) storage.setItem(key(request, 'attempt'), 'pending');
      const operation = (async (): Promise<HumanSendOutcome030> => {
        let result: HumanSendOutcome030['result'] = null;
        let fallback: RunHumanRequest030 | null = null;
        if (!blocked) {
          try {
            result = await submit(input);
            if (result.kind === 'received') {
              const receipt: RunHumanReceipt030 = result.receipt;
              if (humanRequestKey030({ scope: receipt.scope, id: receipt.requestId }) !== identity) throw new Error('CORRELATION');
              fallback = { ...request, revision: receipt.revision, state: receipt.state };
            }
          } catch { result = { kind: 'uncertain', code: 'UNCERTAIN', receiptId: null }; }
          if (result.kind === 'refused' && result.refusal.currentRevision !== null)
            retainMinimum(request, result.refusal.currentRevision);
          storage.setItem(key(request, 'attempt'), result.kind);
        }
        try {
          const current = await readCurrent(request, captureKey);
          if (fallback && (BigInt(current.revision) < BigInt(fallback.revision) ||
              (current.state.kind === 'open' && fallback.state.kind !== 'open')))
            return { result, current: retainReadback(fallback, captureKey), readFailed: true };
          if (storage.getItem(key(request, 'attempt')) === 'refused') storage.removeItem(key(request, 'attempt'));
          return { result, current: retainReadback(current, captureKey), readFailed: false };
        } catch { return { result, current: fallback && retainReadback(fallback, captureKey), readFailed: true }; }
      })();
      pending.set(identity, operation);
      void operation.finally(() => pending.delete(identity)).catch(() => {});
      return operation;
    },
  };
}
export type HumanRequestClient030 = ReturnType<typeof createHumanRequestClient030>;
