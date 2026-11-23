import type { RuntimeInstance030 } from '../../types/generated/ipc';
import type { RunInspection030 } from './runtimeProjection030';
import type { RunOperatorAction030 } from '../ipc/agsdlExecution030';

export function instanceOperatorState030(run: RunInspection030, instance: RuntimeInstance030) {
  const { state } = run;
  const current = instance.currentActivationId ? state.operatorWorks?.[instance.currentActivationId]?.kind : undefined;
  if (current || !state.operatorWorks || state.occurrences.kind !== 'ready') return current;
  if (state.occurrences.value.some(({ activation }) => activation.instanceId === instance.id &&
    state.operatorWorks?.[activation.id]?.kind === 'interrupted')) return 'interrupted';
}

export function threadOperatorAction030(run: RunInspection030, instance: RuntimeInstance030): RunOperatorAction030 | undefined {
  const { state } = run;
  const activationId = instance.currentActivationId;
  if (!activationId || instance.discarded || run.capture.versions.contract !== 'agsdl-0.4.0' ||
    state.paused || state.stopping || state.verdict !== null || state.ownerStatus !== 'live') return;
  const operator = state.operatorWorks?.[activationId]?.kind;
  if (operator === 'held') return { kind: 'resumeWork', activationId };
  if (operator || state.occurrences.kind !== 'ready') return;
  const activation = state.occurrences.value.find(row => row.activation.id === activationId)?.activation;
  if (activation?.phase === 'running' && activation.physical && !activation.stopRequested) {
    return { kind: 'interruptWork', activationId };
  }
}

export function runOperatorAction030(run: RunInspection030): RunOperatorAction030 | undefined {
  const { state } = run;
  if (run.capture.versions.contract !== 'agsdl-0.4.0' || state.ownerStatus !== 'live' ||
    state.verdict !== null || state.stopping) return;
  if (!state.paused) return { kind: 'pauseRun' };
  if (!Object.values(state.operatorWorks ?? {}).some(work => work.kind === 'holding')) return { kind: 'resumeRun' };
}

export function operatorErrorKey030(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'HOST_CAPABILITY') return 'unavailable';
  if (code === 'OPERATOR_TRANSITION' || code === 'CONFLICT' || code === 'CORRELATION') return 'changed';
  return 'failed';
}
