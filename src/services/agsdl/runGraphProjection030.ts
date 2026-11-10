import type { RunOccurrence030, RunScope030, RunRead030 } from '../../types/agsdlRunUi030';
import { object, scanSource } from './document';
import type { StaticSemantics030 } from './staticSemantics030';

/** Capture identity deliberately excludes runtime revision, so refresh keeps selection. */
export function runCaptureKey030(scope: RunScope030): string {
  return JSON.stringify([scope.source.owner.projectId, scope.source.owner.planId, scope.source.owner.branch,
    scope.systemStartId, scope.snapshotId, scope.source.revision, scope.source.sourceSha256]);
}
export function runOccurrenceKey030(occurrence: RunOccurrence030): string {
  return JSON.stringify([runCaptureKey030(occurrence.scope), occurrence.activation.id]);
}
export interface RunGraphOccurrence030 {
  readonly key: string;
  readonly activationId: string;
  readonly nativeOccurrenceId: string | null;
  readonly staticOccurrenceId: string | null;
  readonly sourcePointer: string | null;
  readonly occurrence: RunOccurrence030;
}
/** Expanded addresses match static occurrences; source pointers never merge visits.
 * Static ids and native ids stay in separate fields, even if their text matches. */
export function projectRunGraph030(scope: RunScope030, semantics: StaticSemantics030,
  occurrences: readonly RunOccurrence030[]): RunGraphOccurrence030[] {
  const byAddress = new Map(semantics.occurrences.filter(item => item.address !== null)
    .map(item => [JSON.stringify(item.address), item]));
  return occurrences.filter(item => runCaptureKey030(item.scope) === runCaptureKey030(scope)).map(occurrence => {
    const owner = occurrence.activation.step === null ? undefined : byAddress.get(JSON.stringify(occurrence.activation.step));
    return { key: runOccurrenceKey030(occurrence), activationId: occurrence.activation.id,
      nativeOccurrenceId: occurrence.details.kind === 'available' ? occurrence.details.value.occurrenceId : null,
      staticOccurrenceId: owner?.occurrenceId ?? null,
      sourcePointer: occurrence.details.kind === 'available' ? occurrence.details.value.sourcePointer : null, occurrence };
  });
}

/** Read only the normal outcome discriminator; preserve output bytes for inspection. */
export function normalRunOutcome030(occurrence: RunOccurrence030): 'passed' | 'failed' | 'done' | 'incomplete' | 'reached' | 'missed' | null {
  if (occurrence.details.kind !== 'available' || occurrence.details.value.outputJson === null) return null;
  try {
    const value: unknown = JSON.parse(occurrence.details.value.outputJson);
    if (value === null || typeof value !== 'object' || !('outcome' in value)) return null;
    const outcome = value.outcome;
    return outcome === 'passed' || outcome === 'failed' || outcome === 'done' || outcome === 'incomplete' || outcome === 'reached' || outcome === 'missed' ? outcome : null;
  } catch { return null; }
}

/** Show command output without parsing model or tool data as instructions. */
export function commandResult030(occurrence: RunOccurrence030): { exitCode: string; output: string } | null {
  if (occurrence.activation.agent !== null || occurrence.details.kind !== 'available' || occurrence.details.value.outputJson === null) return null;
  try {
    const value: unknown = JSON.parse(occurrence.details.value.outputJson);
    if (!value || typeof value !== 'object' || !('outcome' in value) || !['passed', 'failed'].includes(String(value.outcome)) || !('data' in value)) return null;
    const data = value.data;
    if (!data || typeof data !== 'object' || !('exitCode' in data) || !Number.isInteger(data.exitCode) || !('output' in data) || typeof data.output !== 'string') return null;
    return { exitCode: String(data.exitCode), output: data.output };
  } catch { return null; }
}

/** Authored titles are presentation data, never runtime identities. */
export function runStepLabels030(source: string, semantics: StaticSemantics030): ReadonlyMap<string, string> {
  const scanned = scanSource(source), decoder = new TextDecoder();
  return new Map(semantics.occurrences.map(step => {
    const span = scanned.spans.get(`${step.sourcePath}/title`);
    const title: unknown = span ? JSON.parse(decoder.decode(scanned.bytes.subarray(span.start, span.end))) : null;
    return [step.occurrenceId, typeof title === 'string' && title.length > 0 ? title : step.address?.join(' / ') ?? step.sourcePath];
  }));
}

/** Read status accompanies the rows, including a retained complete old revision. */
export function runGraphReadState030(read: RunRead030<readonly RunOccurrence030[]>, stale = false, refreshing = false) {
  return {
    availability: refreshing ? 'loading' as const : read.kind === 'stale' ? 'ready' as const : read.kind,
    complete: !refreshing && (read.kind === 'ready' || read.kind === 'stale'),
    revision: read.kind === 'ready' || read.kind === 'stale' ? read.revision : null,
    stale: stale || refreshing || read.kind === 'stale' || (read.kind === 'loading' && read.retained !== null),
  };
}

export type RunEffectFact030 =
  | { readonly kind: 'filesWritten'; readonly files: readonly string[] }
  | { readonly kind: 'workContinues'; readonly value: boolean };

/** Present only recognized, correctly shaped effects. Unknown fields stay in the
 * original diagnostic JSON, without assigning them an invented product meaning. */
export function runEffectFacts030(source: string): RunEffectFact030[] | null {
  try {
    const effects = object(scanSource(source).tree);
    const facts: RunEffectFact030[] = [];
    if (Array.isArray(effects.filesWritten) && effects.filesWritten.every(file => typeof file === 'string')) {
      facts.push({ kind: 'filesWritten', files: effects.filesWritten });
    }
    if (typeof effects.workContinues === 'boolean') facts.push({ kind: 'workContinues', value: effects.workContinues });
    return facts;
  } catch { return null; }
}
