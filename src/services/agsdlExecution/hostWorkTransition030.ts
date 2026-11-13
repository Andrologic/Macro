import type { EngineOwner } from '../../types/generated/ipc/EngineOwner';
import type { EngineWork } from '../../types/generated/ipc/EngineWork';
import { AgentWorkController030, type WorkControllerOptions030, type WorkEvent030 } from './agentWorkController030';
import { copyContract030, type AgentWorkContract030, type ValueSchemaValidator030 } from './agentWorkContracts030';
import { evaluateWorkJournal030 } from './hostWorkJournal030';

/** Captured work context for the pure reference evaluator, not an IPC command. */
export interface EngineContext {
  owner: EngineOwner; work: EngineWork;
  permissionsJson: string; scopeJson: string; registryVersion: string;
}

/** Evaluate only an authenticated native job. SQL owns its receipt, effects,
 * revision and Stop fencing; this function does not execute or route work. */
export function evaluateHostWork030(
  context: EngineContext,
  eventId: string,
  expectedRevision: string,
  contractJson: string,
  stateJson: string,
  eventJson: string,
  optionsJson: string,
  validateValueSchema: ValueSchemaValidator030,
): { readonly stateJson: string; readonly receiptJson: string } {
  if (!context.work.agentInstanceId || context.owner.systemStartId !== context.work.systemStartId) {
    throw new Error('Work context has no attributed agent instance.');
  }
  const owner = {
    systemStartId: context.owner.systemStartId,
    activationId: context.work.activationId,
    agentInstanceId: context.work.agentInstanceId,
    ownerEpoch: context.owner.ownerEpoch,
  };
  const event: unknown = JSON.parse(eventJson);
  if (event === null || typeof event !== 'object' || Array.isArray(event) || !('owner' in event) || !('eventId' in event)) {
    throw new Error('Invalid work event envelope.');
  }
  const eventOwner = event.owner;
  if (event.eventId !== eventId || eventOwner === null || typeof eventOwner !== 'object' || Array.isArray(eventOwner)
    || !('systemStartId' in eventOwner) || eventOwner.systemStartId !== owner.systemStartId
    || !('activationId' in eventOwner) || eventOwner.activationId !== owner.activationId
    || !('agentInstanceId' in eventOwner) || eventOwner.agentInstanceId !== owner.agentInstanceId
    || !('ownerEpoch' in eventOwner) || eventOwner.ownerEpoch !== owner.ownerEpoch) {
    throw new Error('Work event attribution differs from the native job.');
  }
  const contract = copyContract030(JSON.parse(contractJson) as AgentWorkContract030);
  const options = JSON.parse(optionsJson) as WorkControllerOptions030;
  return evaluateWorkJournal030<WorkEvent030, ReturnType<AgentWorkController030['dispatch']>>(
    stateJson, expectedRevision, eventJson,
    () => new AgentWorkController030(owner, contract, validateValueSchema, options),
  );
}
