import type { HumanScope030 } from '../../types/generated/ipc/HumanScope030';
import type { HumanContinuation030 } from '../../types/generated/ipc/HumanContinuation030';
import type { HumanPage030 } from '../../types/generated/ipc/HumanPage030';
import type { PublicHumanRequest030 } from '../../types/generated/ipc/PublicHumanRequest030';
import type { HumanAnswer030 } from '../../types/generated/ipc/HumanAnswer030';
export type ExecutionHumanRequestView =
  | { kind: 'approval'; title: string; description?: string; message: string; choices: readonly { value: string; label: string }[] }
  | { kind: 'plan'; title: string; description?: string; message: string }
  | { kind: 'question'; title: string; description?: string; message: string };
export type ExecutionHumanAnswer =
  | { kind: 'approval'; choice: string; comment: string }
  | { kind: 'plan'; approve: boolean; comment: string }
  | { kind: 'question'; answer: string };

const sameScope = (a: HumanScope030, b: HumanScope030) => a.systemStartId === b.systemStartId &&
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
    if (!sameScope(page.scope, captured) || (cursor !== undefined && page.cursor !== cursor) ||
        !/^(0|[1-9][0-9]*)$/.test(page.total) || (total !== undefined && page.total !== total) ||
        page.requests.length > 64 || (offset > 0 && !page.requests.length)) throw new Error('Invalid human projection page');
    cursor = page.cursor; total = page.total;
    for (const request of page.requests) {
      if (!request.id || ids.has(request.id)) throw new Error('Duplicate human request');
      ids.add(request.id); requests.push(request);
    }
    next = page.nextPage ?? undefined;
    if (next && (!sameScope(next.scope, captured) || next.cursor !== cursor || next.offset !== offset + 64 || page.requests.length !== 64)) throw new Error('Invalid human projection continuation');
    offset += 64;
  } while (next);
  if (BigInt(total!) !== BigInt(requests.length)) throw new Error('Incomplete human projection');
  return { scope: captured, cursor: cursor!, total: total!, requests, nextPage: null };
}

/** Labels for plan/question come from the UI locale, not native identity. */
export function humanRequestView030(request: PublicHumanRequest030, labels: { plan: string; question: string }): ExecutionHumanRequestView {
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
