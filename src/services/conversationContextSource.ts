import type { PersistedContextReference } from '../types';
import type { DbConversation, DbMessage } from './ipc/conversations.types';

const MAX_SOURCES = 3;
const MAX_CANDIDATE_LENGTH = 4_000;
const MAX_PASSAGES = 3;
const MAX_PASSAGE_LENGTH = 850;

type Passage = Pick<DbMessage, 'id' | 'role' | 'content' | 'created_at' | 'completion_reason'>;

export interface ConversationContextSourcePorts {
  getConversation(id: string): Promise<DbConversation | null>;
  listMessages(id: string): Promise<DbMessage[]>;
  isSourceActive(id: string): boolean;
}

const terms = (value: string, limit = 500): Set<string> => new Set(
  (value.slice(0, MAX_CANDIDATE_LENGTH).toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, limit),
);

const isUsablePassage = (message: Passage): boolean => {
  if (!message.content.trim()) return false;
  if (message.role === 'user') return true;
  if (message.role !== 'assistant') return false;
  return message.completion_reason === 'completed' ||
    message.completion_reason === 'length_recovered' ||
    message.completion_reason === 'incomplete_recovered' ||
    message.completion_reason === 'tool_turn_limit' ||
    message.completion_reason === 'post_tool_empty_fallback';
};

/** Select from the current, non-abandoned transcript; the result is frozen on the sent user message. */
export function selectConversationPassages(messages: readonly Passage[], query: string): string {
  const queryTerms = terms(query, 40);
  const candidates = messages
    .filter(isUsablePassage)
    .map((message, index) => {
      const content = message.content.slice(0, MAX_CANDIDATE_LENGTH);
      const passageTerms = terms(content);
      const score = [...queryTerms].reduce((sum, term) => sum + Number(passageTerms.has(term)), 0);
      return { message, content, index, score };
    });
  const matching = candidates.filter((candidate) => candidate.score > 0);
  const selected = (matching.length ? matching : candidates.slice(-1))
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, MAX_PASSAGES)
    .sort((left, right) => left.index - right.index);
  return selected.map(({ message, content }) => {
    const lower = content.toLocaleLowerCase();
    const firstHit = [...queryTerms].map((term) => lower.indexOf(term)).filter((index) => index >= 0)
      .reduce((minimum, index) => Math.min(minimum, index), Infinity);
    const start = Number.isFinite(firstHit) ? Math.max(0, firstHit - 120) : 0;
    const excerpt = content.slice(start, start + MAX_PASSAGE_LENGTH).trim();
    return `[message_id=${message.id}; role=${message.role}; at=${message.created_at}${matching.length ? '' : '; recent_fallback=true'}]\n` +
      `${start > 0 ? '…' : ''}${excerpt}${start + MAX_PASSAGE_LENGTH < message.content.length ? '…' : ''}`;
  }).join('\n\n');
}

export async function resolveConversationContextSources(params: {
  targetConversationId: string;
  request: string;
  refs: readonly PersistedContextReference[] | undefined;
  ports: ConversationContextSourcePorts;
}): Promise<PersistedContextReference[] | undefined> {
  const refs = params.refs;
  if (!refs?.some((ref) => ref.kind === 'conversation')) return refs ? [...refs] : undefined;
  const sourceRefs = refs.filter((ref) => ref.kind === 'conversation');
  if (sourceRefs.length > MAX_SOURCES) throw new Error('Attach at most three conversation sources.');
  const target = await params.ports.getConversation(params.targetConversationId);
  if (!target) throw new Error('The destination conversation is no longer available.');
  const resolved: PersistedContextReference[] = [];
  for (const ref of refs) {
    if (ref.kind !== 'conversation') {
      resolved.push(ref);
      continue;
    }
    const sourceId = ref.conversationId;
    if (!sourceId || sourceId !== ref.id || sourceId === params.targetConversationId) {
      throw new Error('The conversation source is invalid. Remove it and select it again.');
    }
    const source = await params.ports.getConversation(sourceId);
    if (!source || source.project_id !== target.project_id || params.ports.isSourceActive(sourceId)) {
      throw new Error('The conversation source is unavailable or outside this project.');
    }
    const transcript = await params.ports.listMessages(sourceId);
    const current = await params.ports.getConversation(sourceId);
    if (!current || current.project_id !== target.project_id ||
      current.updated_at !== source.updated_at || params.ports.isSourceActive(sourceId)) {
      throw new Error('The conversation source changed while selecting passages. Try sending again.');
    }
    const passage = selectConversationPassages(transcript, params.request);
    if (!passage) throw new Error('The selected conversation has no completed text to cite.');
    resolved.push({
      ...ref,
      title: current.title,
      snippet: passage,
      sourceUpdatedAt: current.updated_at,
    });
  }
  return resolved;
}
