import type { RunInspection030 } from './runtimeProjection030';
import type { RuntimeActivation030 } from '../../types/generated/ipc';
import { MAX_AGSDL_PROJECTION_BYTES, readDocument } from './document';
import { deliverExecution030 } from '../tauriIpc';
import { runCaptureKey030 } from './runGraphProjection030';

/** Messages always target the retained capture, independently of editor changes. */
export function messageTargets030(run: RunInspection030, instanceId?: string): string[] {
  const document = readDocument(run.capture.authoredSource, MAX_AGSDL_PROJECTION_BYTES);
  const agents = Object.keys(document.agents ?? {});
  if (instanceId === undefined) return document.flow ? [] : agents;
  const instance = run.state.instances.find(item => item.id === instanceId);
  if (!instance || instance.discarded || !agents.includes(instance.agent)) return [];
  const hold = instance.currentActivationId && run.state.operatorWorks?.[instance.currentActivationId]?.kind;
  if (hold === 'holding' || (document.flow && hold !== 'held')) return [];
  if (instance.selectorKind === 'shared' || (instance.selectorKind === 'named' && instance.selectorName)) return [instance.agent];
  return [];
}
export function runMessages030(run: RunInspection030, instanceId?: string): RuntimeActivation030[] {
  const occurrences = run.state.occurrences;
  if (occurrences.kind !== 'ready' || occurrences.revision !== run.state.revision) return [];
  const captureKey = runCaptureKey030(run.state.scope);
  const rows = occurrences.value.filter(row => runCaptureKey030(row.scope) === captureKey).map(row => row.activation);
  const scoped = instanceId === undefined ? rows : rows.filter(row => row.instanceId === instanceId);
  return scoped.filter(row => row.message || (instanceId !== undefined && row.workText))
    .sort((a, b) => {
      if (!a.message) return b.message ? 1 : 0;
      if (!b.message) return -1;
      const difference = BigInt(a.message.sequence) - BigInt(b.message.sequence);
      return difference < 0n ? -1 : difference > 0n ? 1 : 0;
    });
}
export function messagePrompt030(raw: string): string {
  try { const value: unknown = JSON.parse(raw); return typeof value === 'object' && value !== null && 'prompt' in value && typeof value.prompt === 'string' ? value.prompt : raw; }
  catch { return raw; }
}
export async function sendRunMessage030(run: RunInspection030, agentName: string, delivery: 'queue' | 'steer', prompt: string, instanceId?: string, deliveryId: string = crypto.randomUUID()): Promise<void> {
  if (run.state.verdict !== null || run.state.stopping || run.state.ownerStatus !== 'live' || !messageTargets030(run, instanceId).includes(agentName) || !prompt.trim()) throw new Error('Message target unavailable');
  const instance = instanceId === undefined ? undefined : run.state.instances.find(item => item.id === instanceId);
  await deliverExecution030({ scope: run.state.scope, deliveryId, agentName, instance: instance?.selectorKind === 'named' ? instance.selectorName : null, delivery, messageJson: JSON.stringify({ prompt }) });
}
