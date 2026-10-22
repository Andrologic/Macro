import type { Closure, EngineActivation, EngineMemory, EngineOwner, HostInspection, Prepare } from '../../types/generated/ipc';
import * as ipc from '../ipc/agsdlExecution';
import { callResult, completionResult, prepareCall } from './constraints';
import { deliveryMessage, validateInput } from './content';
import { COMPILER_VERSION, CONFORMANCE_VERSION, sourceDigest, type CompiledPlan } from './compiler';
import type { ExecutionContext, FrozenAgentConfiguration, MemoryCheckpoint } from './contracts';
import { ConformanceError, decode, encode, equal, fail, record, text, type ExactObject } from './exact';
import { evaluatePureStep, flowFailure, flowInput, retainedAgentOutcome } from './flowValues';
import { metadataArray, metadataJson, metadataObject, metadataText } from './metadata';
import { awaitNativeTool } from './nativeToolDispatch';
import { captureRegistry, captureToolAliases, resolveBinding, validateRegisteredResult, type CapturedRegistry } from './registry';
import { prepareCodexAgent } from './codexAgent';
import { ResidentAgent, nativeResidentAgentPorts, type ResidentAgentPorts, type ResidentAgentRequest } from './residentAgent';

export interface FlowCapture {
  readonly plan: CompiledPlan;
  readonly document: ExactObject;
  readonly registry: CapturedRegistry;
  readonly catalogue: Record<string, unknown>;
  readonly callScopes: readonly { readonly step: readonly string[]; readonly permissionsJson: string; readonly scopeJson: string }[];
}
/** Only metadata envelopes are ordinarily decoded. Authored values, schemas,
 * settings, operands, memory and publications remain exact JSON strings. */
export async function loadFlowCapture(inspection: HostInspection): Promise<FlowCapture> {
  const snapshot = inspection.snapshot;
  const plan = JSON.parse(snapshot.compiledPlanJson) as CompiledPlan;
  if (plan.format !== 'macro-agsdl-compiled-plan/1' || plan.versions.compiler !== COMPILER_VERSION
    || plan.versions.runtime !== CONFORMANCE_VERSION || plan.versions.profile !== 'macro-serial-inline-v1'
    || !equal(decode(JSON.stringify(plan.versions)), decode(JSON.stringify(snapshot.versions)))
    || !equal(decode(JSON.stringify(plan.source)), decode(JSON.stringify(snapshot.source)))
    || snapshot.source.sourceSha256 !== await sourceDigest(snapshot.authoredSource)
    || !equal(decode(plan.documentJson), decode(snapshot.authoredSource))
    || !equal(decode(JSON.stringify(plan.agents)), decode(JSON.stringify(snapshot.agents)))) {
    fail('CORRELATION', '/snapshot', 'Captured plan, source or versions differ from the native snapshot.');
  }
  const capture = metadataObject(JSON.parse(inspection.privateCaptureJson), '/capture');
  if (capture.implementationDigest !== 'macro-native-host/1') fail('UNSUPPORTED', '/capture', 'Captured host implementation is unavailable.');
  const registry = captureRegistry(JSON.parse(metadataText(capture.registryJson, '/capture/registryJson')));
  if (registry.version !== snapshot.versions.registry) fail('CORRELATION', '/registry', 'Captured registry version differs from snapshot.');
  const callScopes = metadataArray(capture.callScopes, '/capture/callScopes').map(value => {
    const scope = metadataObject(value, '/capture/callScopes');
    return { step: metadataArray(scope.step, '/capture/callScopes/step').map(part => metadataText(part, '/step')),
      permissionsJson: metadataJson(scope.permissionsJson, '/permissionsJson'), scopeJson: metadataJson(scope.scopeJson, '/scopeJson') };
  });
  return { plan, document: record(decode(plan.documentJson)), registry, callScopes,
    catalogue: metadataObject(JSON.parse(metadataText(capture.nativeCatalogueJson, '/capture/nativeCatalogueJson')), '/catalogue') };
}
export interface FlowAgent {
  readonly stopRequested: boolean;
  checkpoint(): MemoryCheckpoint;
  acceptInput(adapt: () => import('./contracts').ExactJsonText): Promise<void>;
  executeReady(): ReturnType<ResidentAgent['executeReady']>;
  requestStop(): void;
}
export interface FlowActivationPorts {
  readResponses: typeof ipc.executionHostReadResponses;
  closeResponses: typeof ipc.executionHostCloseResponses;
  invoke: typeof awaitNativeTool;
  prepareAgent(request: ResidentAgentRequest): Promise<FlowAgent>;
  identity(): string;
}
/** Retrying this exact no-effect closure operation retrieves its native receipt.
 * It cannot register or dispatch an effect. A second failure remains uncertain. */
async function retryClosure<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch { return operation(); }
}
export async function prepareFlowAgent(request: ResidentAgentRequest, ports: ResidentAgentPorts = nativeResidentAgentPorts): Promise<FlowAgent> {
  if (request.providerType === 'codex-native') return prepareCodexAgent(request);
  const agent = await ResidentAgent.prepare(request, undefined, { ...ports, journal: { ...ports.journal,
    close: closure => retryClosure(() => ports.journal.close(closure)),
  } });
  let stopRequested = false;
  return { get stopRequested() { return stopRequested; }, checkpoint: () => agent.checkpoint(),
    acceptInput: adapt => agent.acceptInput(adapt), executeReady: () => agent.executeReady(),
    requestStop: () => { stopRequested = true; agent.requestStop(); } };
}
export const nativeFlowActivationPorts: FlowActivationPorts = {
  readResponses: ipc.executionHostReadResponses, closeResponses: ipc.executionHostCloseResponses,
  invoke: awaitNativeTool, prepareAgent: prepareFlowAgent, identity: () => crypto.randomUUID(),
};
/** Pure/Call/input-rejected work has no visible provider response. Native read
 * and close supply the real digest and reject every unresolved physical effect. */
async function closeEmpty(owner: EngineOwner, work: EngineActivation['delivery']['work'], ports: FlowActivationPorts): Promise<Closure> {
  const [events, digest] = await ports.readResponses(owner, work);
  if (events.length) fail('CORRELATION', '/responses', 'A no-response boundary contains provider emissions.');
  const closure = { owner, work, cursor: '0', digest, validationJson: '{"kind":"success","text":"","resultsJson":"{}","choice":null}' };
  const receipt = await retryClosure(() => ports.closeResponses(closure));
  if (receipt.cursor !== closure.cursor || receipt.digest !== digest || !equal(decode(receipt.validationJson), decode(closure.validationJson))) {
    fail('CORRELATION', '/responses', 'Native no-response closure receipt differs.');
  }
  return receipt;
}
function declaration(capture: FlowCapture, activation: EngineActivation): { step: ExactObject; declarationJson: string | null; publicationContractJson: import('./contracts').ExactJsonText | null } {
  const address = activation.delivery.work.step;
  if (address === null) {
    if (capture.plan.entry !== null || activation.delivery.input.origin !== 'entry') fail('CORRELATION', '/step', 'Graphless input does not belong to a graphless system.');
    return { step: {}, declarationJson: null, publicationContractJson: null };
  }
  const compiled = capture.plan.steps.find(step => step.address.length === address.length && step.address.every((part, index) => part === address[index]));
  if (!compiled) fail('CORRELATION', '/step', 'Admitted step is absent from the captured plan.');
  return { step: record(decode(compiled.declarationJson)), declarationJson: compiled.declarationJson, publicationContractJson: compiled.publicationContractJson };
}
function stopRequested(activation: EngineActivation, inspection: HostInspection): boolean {
  return activation.stopState.kind !== 'none' || inspection.projection.systemStop.kind !== 'none';
}
export async function executeFlowActivation(owner: EngineOwner, activation: EngineActivation, memory: EngineMemory | null,
  inspection: HostInspection, capture: FlowCapture, onAgent: (agent: FlowAgent) => void, ports = nativeFlowActivationPorts): Promise<Prepare> {
  const { work, input } = activation.delivery;
  const declared = declaration(capture, activation);
  const step = declared.step;
  let outcome: Prepare['outcome'];
  let selectedBranch: string | null = null;
  let checkpoint: Prepare['memory'] = null;
  let closure: Pick<Closure, 'cursor' | 'digest'>;
  if (work.agentInstanceId !== null) {
    const identity = inspection.agents.find(agent => agent.agentInstanceId === work.agentInstanceId);
    const configuration = capture.plan.agents.find(agent => agent.agentName === identity?.agentName);
    if (!configuration || work.step !== null && (step.type !== 'agent' || step.agent !== configuration.agentName)) {
      fail('CORRELATION', '/agent', 'Admitted Agent differs from its captured declaration.');
    }
    const agentDeclaration = record(record(capture.document.agents)[configuration.agentName]);
    const interfaceValue = record(agentDeclaration.interface ?? {});
    const expanded = record(decode(configuration.configurationJson));
    const provider = metadataArray(capture.catalogue.providers, '/providers').map(value => metadataObject(value, '/provider'))
      .find(value => value.providerId === configuration.providerId);
    const nativeCodex = record(expanded.nativeEngine ?? {}).adapter === 'codex-app-server-v1';
    if (!nativeCodex && (!provider || !['openai', 'ollama', 'lmstudio'].includes(metadataText(provider.providerType, '/providerType')))) {
      fail('UNSUPPORTED', '/provider', 'Captured Agent transport is unavailable.');
    }
    const context = { owner, work, permissionsJson: configuration.permissionsJson, scopeJson: configuration.scopeJson,
      registryVersion: capture.registry.version } as ExecutionContext;
    const agent = await ports.prepareAgent({ context, configuration: configuration as FrozenAgentConfiguration, memory: memory as MemoryCheckpoint | null,
      providerType: nativeCodex ? 'codex-native' : provider!.providerType as ResidentAgentRequest['providerType'],
      toolAliases: captureToolAliases(capture.document, record(expanded.configuration), capture.registry),
      responses: { agentName: configuration.agentName, interfaceJson: encode(interfaceValue),
        stepJson: declared.declarationJson as import('./contracts').ExactJsonText | null,
        publicationContractJson: work.step === null ? capture.plan.graphlessPublicationContracts[configuration.agentName] ?? null : declared.publicationContractJson } });
    onAgent(agent);
    if (stopRequested(activation, inspection)) agent.requestStop();
    if (agent.stopRequested) {
      // A local abort is only a request. Native close proves this boundary has
      // no emissions and no unresolved effects before a stopped terminal exists.
      checkpoint = agent.checkpoint();
      closure = await closeEmpty(owner, work, ports);
      outcome = { kind: 'stopped', evidenceJson: '{"kind":"native-no-effect-closure"}' };
      return terminal();
    }
    // An input rejection occurs after real initialization and before provider work.
    try {
      await agent.acceptInput(() => {
        const message = deliveryMessage(capture.document, flowInput(input));
        validateInput(message, interfaceValue);
        return message;
      });
    } catch (error) {
      if (!(error instanceof ConformanceError)) throw error;
      outcome = flowFailure(error, interfaceValue, step);
      checkpoint = agent.checkpoint();
      closure = await closeEmpty(owner, work, ports);
      return terminal();
    }
    if (agent.stopRequested) {
      checkpoint = agent.checkpoint();
      closure = await closeEmpty(owner, work, ports);
      outcome = { kind: 'stopped', evidenceJson: '{"kind":"native-no-effect-closure"}' };
      return terminal();
    }
    const result = await agent.executeReady();
    outcome = retainedAgentOutcome(result, interfaceValue, step);
    checkpoint = result.memory;
    closure = result.closure;
    if (outcome.kind === 'completed') {
      // Reuse the actual language validator over the native retained publication.
      outcome = { kind: 'completed', output: completionResult(interfaceValue, step, decode(outcome.output.valueJson)) };
      selectedBranch = record(step.decision ?? {}).choices === undefined ? null : text(record(decode(outcome.output.valueJson)).choice);
    }
  } else {
    if (stopRequested(activation, inspection)) {
      closure = await closeEmpty(owner, work, ports);
      outcome = { kind: 'stopped', evidenceJson: '{"kind":"native-no-effect-closure"}' };
      return terminal();
    }
    try {
      if (step.type === 'call') {
        const prepared = prepareCall(capture.document, step, flowInput(input), capture.registry);
        const scope = capture.callScopes.find(item => work.step !== null && item.step.length === work.step.length && item.step.every((part, index) => part === work.step![index]));
        if (!scope) fail('CORRELATION', '/scope', 'Call has no native captured permission ceiling.');
        const receipt = await ports.invoke({ context: { owner, work, permissionsJson: scope.permissionsJson, scopeJson: scope.scopeJson, registryVersion: capture.registry.version },
          toolInvocationId: ports.identity(), providerAttemptId: null, bindingJson: prepared.bindingJson, argumentsJson: prepared.argumentsJson, callScopeJson: prepared.scopeJson });
        if (receipt.failed) outcome = flowFailure(new ConformanceError('CALL_FAILED', '', 'Native Call ended with a technical failure.'));
        else {
          const binding = resolveBinding(capture.document, text(step.binding), capture.registry, 'call');
          try {
            validateRegisteredResult(binding, receipt.resultJson as import('./contracts').ExactJsonText);
            outcome = { kind: 'completed', output: callResult(decode(receipt.resultJson), binding.resultConstraintJson) };
          } catch (error) {
            if (!(error instanceof ConformanceError)) throw error;
            outcome = flowFailure(new ConformanceError('CALL_RESULT', error.pointer, error.message));
          }
        }
      } else {
        const result = evaluatePureStep(capture.document, step, input);
        outcome = result.outcome;
        selectedBranch = result.selectedBranch;
      }
    } catch (error) {
      // NativeInvocation converts an ambiguous IPC acknowledgement into a physical
      // uncertainty error. Only a correlated language/refusal error reaches here.
      if (!(error instanceof ConformanceError)) throw error;
      // A cancelled approval has no registered effect. The native closure below
      // still must prove that no physical work remains before Stop is terminal.
      outcome = error.code === 'STOP_CANCELLED'
        ? { kind: 'stopped', evidenceJson: '{"kind":"native-no-effect-closure"}' }
        : flowFailure(error);
    }
    closure = await closeEmpty(owner, work, ports);
  }
  return terminal();

  function terminal(): Prepare {
    return { owner, work, outcome, responseCursor: closure.cursor, terminationEvidenceJson: '{"kind":"native-response-closure"}', memory: checkpoint,
      validation: { snapshotDigest: inspection.snapshotDigest, input, declarationJson: declared.declarationJson, closureDigest: closure.digest, selectedBranch } };
  }
}
/** VISIT_LIMIT is a native no-effect admission reservation. Do not initialize or
 * increment the Agent checkpoint to resolve it. */
export async function resolveFlowVisitLimit(owner: EngineOwner, activation: EngineActivation, inspection: HostInspection,
  capture: FlowCapture, ports = nativeFlowActivationPorts): Promise<Prepare> {
  const declared = declaration(capture, activation);
  const work = activation.delivery.work;
  const memory = inspection.agents.find(agent => agent.agentInstanceId === work.agentInstanceId)?.memory ?? null;
  const closure = await closeEmpty(owner, work, ports);
  return { owner, work, memory, outcome: stopRequested(activation, inspection)
    ? { kind: 'stopped', evidenceJson: '{"kind":"native-no-effect-visit-limit"}' }
    : flowFailure(new ConformanceError('VISIT_LIMIT', '', 'Native visit admission exceeded the captured step limit.')),
    responseCursor: closure.cursor, terminationEvidenceJson: '{"kind":"native-no-effect-visit-limit"}',
    validation: { snapshotDigest: inspection.snapshotDigest, input: activation.delivery.input, declarationJson: declared.declarationJson, closureDigest: closure.digest, selectedBranch: null } };
}
