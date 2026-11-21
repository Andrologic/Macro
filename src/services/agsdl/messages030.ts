import type { RunInspection030 } from './runtimeProjection030';
import type { RuntimeActivation030 } from '../../types/generated/ipc';
import { readDocument } from './document';
import { deliverExecution030 } from '../tauriIpc';

/** Messages always target the retained capture, independently of editor changes. */
export function messageTargets030(run: RunInspection030, instanceId?: string): string[] {
  const document = readDocument(run.capture.authoredSource);
  if (document.flow) return [];
  const agents = Object.keys(document.agents ?? {});
  if (instanceId === undefined) return agents;
  const instance = run.state.instances.find(item => item.id === instanceId);
  if (!instance || instance.discarded || !agents.includes(instance.agent)) return [];
  if (instance.selectorKind === 'shared' || (instance.selectorKind === 'named' && instance.selectorName)) return [instance.agent];
  return [];
}
export function runMessages030(run: RunInspection030): RuntimeActivation030[] {
  const occurrences = run.state.occurrences;
  return occurrences.kind === 'ready' ? occurrences.value.map(row => row.activation).filter(row => row.message).sort((a, b) => BigInt(a.message!.sequence) < BigInt(b.message!.sequence) ? -1 : 1) : [];
}
export function messagePrompt030(raw: string): string {
  try { const value: unknown = JSON.parse(raw); return typeof value === 'object' && value !== null && 'prompt' in value && typeof value.prompt === 'string' ? value.prompt : raw; }
  catch { return raw; }
}
export async function sendRunMessage030(run: RunInspection030, agentName: string, delivery: 'queue' | 'steer', prompt: string, instanceId?: string): Promise<void> {
  if (run.state.verdict !== null || run.state.stopping || !messageTargets030(run, instanceId).includes(agentName) || !prompt.trim()) throw new Error('Message target unavailable');
  const instance = instanceId === undefined ? undefined : run.state.instances.find(item => item.id === instanceId);
  await deliverExecution030({ scope: run.state.scope, deliveryId: crypto.randomUUID(), agentName, instance: instance?.selectorKind === 'named' ? instance.selectorName : null, delivery, messageJson: JSON.stringify({ prompt }) });
}
