import { StreamStopUnconfirmedError } from '../ai/streamCancellation';
import type { EngineOwner, EngineOutcome } from '../../types/generated/ipc';
import * as ipc from '../ipc/agsdlExecution';
import type { CompiledPlan } from './compiler';
import type { ExecutionContext, ExactJsonText, MemoryCheckpoint } from './contracts';
import { decode, encode, fail, record } from './exact';
import { captureRegistry, captureToolAliases } from './registry';
import { ResidentAgent } from './residentAgent';

type QaExecutionPhase = 'capture' | 'prepareAgent' | 'adaptInput' | 'executeAgent' | 'prepareTerminal' | 'commitTerminal';
const diagnosticCodes = new Set(['CORRELATION', 'INPUT_CONSTRAINT', 'OUTPUT_CONSTRAINT', 'PERMISSION', 'APPROVAL',
  'UNSUPPORTED', 'STORAGE', 'VERSION_UNAVAILABLE', 'RUNTIME_UNAVAILABLE', 'PARSE', 'INVALID_RECORD']);
/** Only fixed phase/code labels may enter the public diagnostic projection. */
export function qaFailureReason(phase: QaExecutionPhase, error: unknown): string {
  const suppliedCode = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = error instanceof StreamStopUnconfirmedError ? 'STOP_UNCONFIRMED'
    : typeof suppliedCode === 'string' && diagnosticCodes.has(suppliedCode) ? suppliedCode : 'UNEXPECTED';
  return `Resident execution failed at ${phase} (${code}); terminal receipt unconfirmed.`;
}

type QaClosedResult = Pick<Awaited<ReturnType<ResidentAgent['executeReady']>>, 'closure' | 'stopped' | 'failed'>;
/** Called only after executeReady returned a native response closure. */
export function qaTerminalOutcome(result: QaClosedResult): EngineOutcome {
  const validation = result.closure.validation;
  let outcome: EngineOutcome;
  if (result.stopped) outcome = { kind: 'stopped', evidenceJson: '{"kind":"native-response-closure"}' };
  else if (result.failed || validation.kind === 'failure') {
    const code = validation.kind === 'failure' ? validation.code : 'AGENT_FAILED';
    outcome = { kind: 'failed', code, errorJson: encode({ error: { code, message: 'Resident Agent did not complete successfully.', details: [] } }) };
  } else outcome = { kind: 'completed', output: { origin: 'agent', valueJson: encode({ text: validation.text,
    results: decode(validation.resultsJson), ...(validation.choice === null ? {} : { choice: validation.choice }) }) } };
  return outcome;
}

/** One manual QA delivery, already created by the native graphless port.
 * SQL begin owns admission and duplicates. This helper never scans or pumps FIFO. */
export async function runQaGraphless(owner: EngineOwner, deliveryId: string): Promise<void> {
  const inspection = await ipc.executionHostInspect(owner);
  const plan = JSON.parse(inspection.snapshot.compiledPlanJson) as CompiledPlan;
  if (plan.entry !== null) return fail('CORRELATION', '', 'Manual QA only accepts graphless work.');
  const admission = await ipc.executionHostBegin(owner, deliveryId);
  if (admission.kind !== 'admitted') return;
  const { work, input } = admission.activation.delivery;
  let phase: QaExecutionPhase = 'capture';
  let agent: ResidentAgent | undefined;
  let finished = false;
  let watch: Promise<void> | undefined;
  try {
    const identity = inspection.agents.find(agent => agent.agentInstanceId === work.agentInstanceId);
    const configuration = plan.agents.find(agent => agent.agentName === identity?.agentName);
    if (!configuration || work.step !== null || input.origin !== 'entry') return fail('CORRELATION', '', 'Graphless admission has no captured Agent.');
    const capture = JSON.parse(inspection.privateCaptureJson);
    const catalogue = JSON.parse(capture.nativeCatalogueJson);
    const provider = catalogue.providers.find((item: { providerId: string }) => item.providerId === configuration.providerId);
    if (!provider || !['openai', 'ollama', 'lmstudio'].includes(provider.providerType)) return fail('UNSUPPORTED', '', 'Captured provider transport is unavailable.');
    const document = record(decode(plan.documentJson));
    const expanded = record(decode(configuration.configurationJson));
    const context = { owner, work, permissionsJson: configuration.permissionsJson, scopeJson: configuration.scopeJson,
      registryVersion: inspection.snapshot.versions.registry } as ExecutionContext;
    phase = 'prepareAgent';
    agent = await ResidentAgent.prepare({ context, configuration, memory: admission.memory as MemoryCheckpoint | null,
      providerType: provider.providerType, toolAliases: captureToolAliases(document, record(expanded.configuration), captureRegistry(JSON.parse(capture.registryJson))),
      responses: { agentName: configuration.agentName, interfaceJson: encode(record(record(document.agents)[configuration.agentName]).interface ?? {}), stepJson: null,
        publicationContractJson: plan.graphlessPublicationContracts[configuration.agentName] ?? null } });
    phase = 'adaptInput';
    await agent.acceptInput(() => input.valueJson as ExactJsonText);
    watch = (async () => {
      while (!finished) {
        try {
          const current = await ipc.executionHostInspect(owner);
          const activation = current.projection.activations.find(item => item.delivery.deliveryId === deliveryId);
          if (current.projection.systemStop.kind !== 'none' || activation?.stopState.kind !== 'none') agent!.requestStop();
        } catch { agent!.requestStop(); return; }
        if (!finished) await new Promise(resolve => setTimeout(resolve, 150));
      }
    })();
    phase = 'executeAgent';
    const result = await agent.executeReady();
    const outcome = qaTerminalOutcome(result);
    phase = 'prepareTerminal';
    const witnessId = await ipc.executionHostPrepareTerminal({ owner, work, outcome, responseCursor: result.closure.cursor,
      terminationEvidenceJson: '{"kind":"native-response-closure"}', memory: result.memory,
      validation: { snapshotDigest: inspection.snapshotDigest, input, declarationJson: null, closureDigest: result.closure.digest, selectedBranch: null } });
    phase = 'commitTerminal';
    await ipc.executionHostCommitTerminal(owner, witnessId);
  } catch (error) {
    // Never turn a lost receipt into a successful terminal or replay an effect.
    await ipc.executionHostMarkUncertain(owner, work, qaFailureReason(phase, error)).catch(() => undefined);
  } finally {
    finished = true;
    await watch;
  }
}
