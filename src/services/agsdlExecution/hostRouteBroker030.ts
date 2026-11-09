import { evaluateHostHumanClock030 } from './hostHumanClock030';
import { commandOutput030, mcpOutput030, prepareCall030, type PreparedCall030, type CommandReceipt030, type McpReceipt030 } from './calls030';
import type { RouteSource030 } from './routes030';
import type { ExactJsonText } from './contracts';
import type { HostRouteJob030, HostRouteOutput030 } from '../../types/generated/ipc';
import { executionHostCompleteRoute030, executionHostFailed, executionHostNextRoute030 } from '../ipc/agsdlExecution';
import { capturedContent030, type CapturedContentReceipt030, type ContentCaptureIdentity030 } from './contentResolution030';
import { ConformanceError } from './exact';
import { prepareFlowRoute030, type PrepareFlowRouteInput030 } from './prepareFlowRoute030';
import type { HostWorkPumpPort030 } from './hostWorkPump030';

type NativeContentCache030 =
  | { readonly identity: ContentCaptureIdentity030; readonly receipts: readonly CapturedContentReceipt030[] }
  | { readonly format: 'macro-agsdl-route-content/1'; readonly occurrences: readonly {
    readonly targetOrdinal: number; readonly itemIndex: string; readonly contextId: string;
    readonly identity: ContentCaptureIdentity030; readonly receipts: readonly CapturedContentReceipt030[];
  }[] };
type NativeRouteInput030 = Omit<PrepareFlowRouteInput030, 'content' | 'contentForOccurrence'> & {
  readonly contentReceipts: NativeContentCache030;
};

/** This selects already-attested receipts; it never establishes their authority. */
export function capturedContentForOccurrence030(cache: NativeContentCache030): NonNullable<PrepareFlowRouteInput030['contentForOccurrence']> {
  const entries = new Map<string, ReturnType<typeof capturedContent030>>();
  if ('format' in cache) {
    if (cache.format !== 'macro-agsdl-route-content/1' || !Array.isArray(cache.occurrences)) throw new Error('Invalid content cache.');
    const contexts = new Set<string>();
    for (const occurrence of cache.occurrences) {
      if (!Number.isSafeInteger(occurrence.targetOrdinal) || occurrence.targetOrdinal < 0 ||
          typeof occurrence.itemIndex !== 'string' || !/^(0|[1-9][0-9]*)$/.test(occurrence.itemIndex) || typeof occurrence.contextId !== 'string' || !occurrence.contextId ||
          !occurrence.identity || !['captureId', 'sourceDigest', 'agent', 'policyDigest'].every(key =>
            typeof occurrence.identity[key as keyof ContentCaptureIdentity030] === 'string' && occurrence.identity[key as keyof ContentCaptureIdentity030].length > 0) ||
          !Array.isArray(occurrence.receipts)) throw new Error('Invalid content occurrence.');
      const key = `${occurrence.targetOrdinal}:${occurrence.itemIndex}`;
      if (entries.has(key) || contexts.has(occurrence.contextId)) throw new Error('Duplicate content occurrence.');
      contexts.add(occurrence.contextId);
      entries.set(key, capturedContent030(occurrence.identity, occurrence.receipts));
    }
  } else if (!cache.identity || typeof cache.identity !== 'object' || !Array.isArray(cache.receipts) || cache.receipts.length !== 0) {
    throw new Error('Legacy content receipts cannot authorize an occurrence.');
  }
  return (targetOrdinal, itemIndex) => entries.get(`${targetOrdinal}:${itemIndex}`) ?? {};
}

/** Pure call data, issued by the same native ticket owner as routes. */
export function evaluateCallData030(input: {
  operation: 'prepare' | 'normalize'; stepJson: ExactJsonText; source: RouteSource030;
  prepared: PreparedCall030; receipt: CommandReceipt030 & McpReceipt030;
}): string {
  try {
    if (input.operation === 'prepare') return JSON.stringify({ kind: 'prepared', prepared: prepareCall030(input.stepJson, input.source) });
    return JSON.stringify({ kind: 'completed', outputJson: input.prepared.kind === 'command'
      ? commandOutput030(input.prepared, input.receipt) : mcpOutput030(input.receipt) });
  } catch (error) {
    if (!(error instanceof ConformanceError)) throw error;
    return JSON.stringify({ kind: 'failed', code: error.code });
  }
}

/** The resident mailbox transports data only; native code revalidates and commits it. */
export function createHostRoutePort030(generation: string): HostWorkPumpPort030<HostRouteJob030, HostRouteOutput030> {
  return {
    next: executionHostNextRoute030,
    async evaluate(job) {
      if (job.generation !== generation) throw new Error('Route mailbox generation changed.');
      try {
        const parsed = JSON.parse(job.inputJson) as NativeRouteInput030 & { content?: unknown; contentForOccurrence?: unknown };
        if ('operation' in parsed && parsed.operation === 'humanClock') {
          const { input } = parsed as unknown as { input: { owner: Parameters<typeof evaluateHostHumanClock030>[0]; eventId: string; expectedRevision: string; stateJson: string; eventJson: string; optionsJson: string } };
          return { kind: 'ready', resultJson: JSON.stringify(evaluateHostHumanClock030(input.owner, input.eventId, input.expectedRevision, input.stateJson, input.eventJson, JSON.parse(input.optionsJson))) };
        }
        if ('operation' in parsed && (parsed.operation === 'prepare' || parsed.operation === 'normalize')) {
          return { kind: 'ready', resultJson: evaluateCallData030(parsed as unknown as Parameters<typeof evaluateCallData030>[0]) };
        }
        delete parsed.content;
        delete parsed.contentForOccurrence;
        const { contentReceipts, ...input } = parsed as NativeRouteInput030;
        const contentForOccurrence = capturedContentForOccurrence030(contentReceipts);
        return { kind: 'ready', resultJson: JSON.stringify(prepareFlowRoute030({ ...input, contentForOccurrence })) };
      } catch (error) {
        return error instanceof ConformanceError
          ? { kind: 'failed', code: error.code, pointer: error.pointer }
          : { kind: 'failed', code: 'ROUTE_PREPARATION_FAILED', pointer: '' };
      }
    },
    complete(job, output) {
      return executionHostCompleteRoute030({ ticket: job.ticket, generation: job.generation, inputDigest: job.inputDigest, output });
    },
    isStaleCompletion(error) {
      return typeof error === 'object' && error !== null && 'code' in error && error.code === 'STALE_TICKET';
    },
    async fail() { await executionHostFailed(); },
  };
}
