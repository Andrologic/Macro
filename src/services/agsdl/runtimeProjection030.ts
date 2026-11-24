import type { OperateRunFacts } from '../../types/generated/ipc/OperateRunFacts';
import type { NativeFact030, RunCapture030, RunRead030, RunStateUi030 } from '../../types/agsdlRunUi030';
import type { RuntimeProjectionScope030 } from '../../types/generated/ipc/RuntimeProjectionScope030';
import type { RuntimeProjectionQuery030 } from '../../types/generated/ipc/RuntimeProjectionQuery030';
import type { RuntimeProjectionContinuation030 } from '../../types/generated/ipc/RuntimeProjectionContinuation030';
import type { RuntimeProjectionPage030 } from '../../types/generated/ipc/RuntimeProjectionPage030';
import type { RuntimeProjectionItem030 } from '../../types/generated/ipc/RuntimeProjectionItem030';

const equalScope = (a: RuntimeProjectionScope030, b: RuntimeProjectionScope030) =>
  a.systemStartId === b.systemStartId && a.snapshotId === b.snapshotId &&
  a.source.revision === b.source.revision && a.source.sourceSha256 === b.source.sourceSha256 &&
  a.source.owner.projectId === b.source.owner.projectId && a.source.owner.planId === b.source.owner.planId && a.source.owner.branch === b.source.owner.branch;
const order = { instance: 0, activation: 1, group: 2, path: 3 } as const;
const utf8 = new TextEncoder();
/** Rust String ordering compares UTF-8 bytes, not UTF-16 code units. */
function compareIds(a: string, b: string): number {
  const left = utf8.encode(a), right = utf8.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}

/** Returns a complete single-revision view or nothing. Native conflicts are
 * propagated; no partial page is published. Selection identity is rechecked
 * after every awaited transport call. */
export async function loadRuntimeProjection030(scope: RuntimeProjectionQuery030, flowInvocationId: string,
  read: (scope: RuntimeProjectionQuery030, continuation?: RuntimeProjectionContinuation030) => Promise<RuntimeProjectionPage030>,
  current: () => boolean): Promise<RuntimeProjectionPage030 | undefined> {
  const expected = structuredClone(scope);
  const items: RuntimeProjectionItem030[] = [];
  let continuation: RuntimeProjectionContinuation030 | undefined;
  let first: RuntimeProjectionPage030 | undefined;
  let last: RuntimeProjectionItem030 | undefined;
  let offset = 0;
  do {
    if (!current()) return undefined;
    const query = continuation ? { ...expected, snapshotId: continuation.scope.snapshotId } : expected;
    const page = await read(structuredClone(query), continuation && structuredClone(continuation));
    if (!current()) return undefined;
    if (!page.scope.snapshotId || page.scope.systemStartId !== expected.systemStartId ||
        (expected.snapshotId !== null && page.scope.snapshotId !== expected.snapshotId) ||
        !equalScope(page.scope, { ...expected, snapshotId: page.scope.snapshotId }) ||
        (first && !equalScope(page.scope, first.scope)) || page.flowInvocationId !== flowInvocationId || !page.flowInvocationId ||
        !/^(0|[1-9][0-9]*)$/.test(page.total) || page.items.length > 100 ||
        (first && (page.revision !== first.revision || page.total !== first.total || page.stopping !== first.stopping || page.verdict !== first.verdict ||
          !!page.paused !== !!first.paused || !!page.interruptedWhilePaused !== !!first.interruptedWhilePaused ||
          (page.terminationUncertain === true) !== (first.terminationUncertain === true))) ||
        (offset > 0 && page.items.length === 0)) throw new Error('Invalid runtime projection page');
    first ??= structuredClone(page);
    for (const item of page.items) {
      if (!Object.hasOwn(order, item.kind) || typeof item.value?.id !== 'string' || !item.value.id || (last && (order[item.kind] < order[last.kind] ||
        (order[item.kind] === order[last.kind] && compareIds(last.value.id, item.value.id) >= 0)))) throw new Error('Invalid runtime projection order');
      items.push(item); last = item;
    }
    continuation = page.nextPage ?? undefined;
    offset += page.items.length;
    if (continuation && (!equalScope(continuation.scope, page.scope) || continuation.revision !== page.revision ||
      continuation.offset !== offset || page.items.length !== 100)) throw new Error('Invalid runtime projection continuation');
  } while (continuation);
  if (!first || BigInt(first.total) !== BigInt(items.length)) throw new Error('Incomplete runtime projection');
  return { ...first, items, nextPage: null };
}

/** Retain native object and branch ordering; never infer identities from cards. */
export function selectRuntimeProjection030(page: RuntimeProjectionPage030, kind: RuntimeProjectionItem030['kind'], id: string): RuntimeProjectionItem030 | undefined {
  return page.items.find(item => item.kind === kind && item.value.id === id);
}

/** The native section order and nested FIFO/branch orders remain untouched. */
export function runtimeSections030(page: RuntimeProjectionPage030) {
  return {
    instances: page.items.filter((item): item is Extract<RuntimeProjectionItem030, {kind:'instance'}> => item.kind === 'instance').map(item => item.value),
    activations: page.items.filter((item): item is Extract<RuntimeProjectionItem030, {kind:'activation'}> => item.kind === 'activation').map(item => item.value),
    groups: page.items.filter((item): item is Extract<RuntimeProjectionItem030, {kind:'group'}> => item.kind === 'group').map(item => item.value),
    paths: page.items.filter((item): item is Extract<RuntimeProjectionItem030, {kind:'path'}> => item.kind === 'path').map(item => item.value),
  };
}

/** Read-only product adapter for lot 6. No method admits or acknowledges work.
 * Snapshots are immutable and referentially stable until subscribe notifies.
 * Each series is assembled atomically before ready; conflicts retain old data.
 * scopeKey includes project, plan, branch and conversation. */
export interface RunInspectionAccess030 {
  readonly scopeKey: string;
  getSnapshot(): RunMonitorSnapshot030;
  subscribe(listener: () => void): () => void;
  refreshHistory(): Promise<void>;
  refreshCatalog?(): Promise<void>;
  refreshRun(systemStartId: string): Promise<void>;
}

export interface RunInspection030 {
  readonly inbox?: OperateRunFacts;
  readonly observation?: { readonly order: number; readonly atMs: number };
  readonly capture: RunCapture030;
  readonly state: RunStateUi030;
}
export type RunHistoryEntry030 = Pick<RunInspection030['state'], 'scope' | 'verdict' | 'physicalPending' | 'humans' | 'chronology'> & {
  readonly capture: RunInspection030['capture'];
  readonly interruptedAt?: string | null;
  readonly stopping?: boolean;
  readonly paused?: boolean;
  readonly inbox?: OperateRunFacts;
  readonly observation?: { readonly order: number; readonly atMs: number };
};
export interface RunReadFailure030 {
  readonly kind: 'conflict' | 'scope' | 'notFound' | 'transport' | 'uncertain';
  readonly code: string;
  readonly message: string;
  readonly revision: string | null;
}
export interface RunMonitorSnapshot030 {
  /** Native history order, newest first. Ready means the whole scope was read. */
  readonly history: RunRead030<readonly RunHistoryEntry030[]>;
  /** Discovery order includes failed reads, but never excluded scopes. */
  readonly historyOrder: readonly string[];
  /** Only an admission with a valid native start030 run receipt supplies an id. */
  readonly retainedAdmission: NativeFact030<string | null>;
  readonly runs: Readonly<Record<string, RunRead030<RunInspection030>>>;
  /** Every failed run stays visible independently of successful history rows. */
  readonly runFailures: Readonly<Record<string, RunReadFailure030>>;
}

export function retainedRunValue030<T>(read: RunRead030<T>): T | null {
  return read.kind === 'ready' ? read.value : read.kind === 'stale' || read.kind === 'loading' ? read.retained : null;
}

/** A partial history or unavailable human DTO cannot prove no human is waiting. */
export function initialRunSelection030(snapshot: RunMonitorSnapshot030, explicit?: string): string | undefined {
  const history = retainedRunValue030(snapshot.history);
  if (explicit && history?.some(run => run.scope.systemStartId === explicit)) return explicit;
  if (snapshot.history.kind !== 'ready') return undefined;
  const runs = snapshot.history.value;
  // Choose the newest attested wait even when another run's waits are unknown.
  const waiting = runs.find(run => run.humans.kind === 'ready' && run.humans.value.some(request => request.state.kind === 'open'));
  if (waiting) return waiting.scope.systemStartId;
  if (Object.keys(snapshot.runFailures).length > 0) return undefined;
  // Unknown waits only prevent falling back to an admission or the newest run.
  if (runs.some(run => run.humans.kind !== 'ready')) return undefined;
  if (snapshot.retainedAdmission.kind !== 'available') return undefined;
  const admission = snapshot.retainedAdmission.value;
  return runs.find(run => run.scope.systemStartId === admission)?.scope.systemStartId ?? runs[0]?.scope.systemStartId;
}
