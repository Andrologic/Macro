import { prepareCall } from './services/agsdlExecution/constraints';
import { assessNativeToolPolicy } from './services/agsdlExecution/nativeToolPolicy';
import { executionHostFailed, executionHostCompleteCompile, executionHostNextCompile, executionHostReady } from './services/tauriIpc';
import { compilePlan } from './services/agsdlExecution/compiler';
import { captureSourceRevision } from './services/agsdlExecution/metadata';
import { buildNativeRegistry, type NativeRegistryObservation } from './services/agsdlExecution/nativeRegistry';
import { normalizeMessage } from './services/agsdlExecution/content';
import { ConformanceError, decode, record } from './services/agsdlExecution/exact';
import { captureRegistry } from './services/agsdlExecution/registry';

// This entry never mounts App or a product view. Native ownership survives main reload.
async function handshake(): Promise<string> {
  // The webview can load before its native ResourceTable installation returns.
  for (let attempt = 0; ; attempt++) {
    try { return await executionHostReady(); }
    catch (error) {
      if (attempt === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
async function start(): Promise<void> {
  const generation = await handshake();
  for (;;) {
    const job = await executionHostNextCompile();
    if (job.generation !== generation) throw new Error('Compiler generation changed.');
    // Only the registry transport envelope uses ordinary JSON. Authored source,
    // declarations, schemas, settings and exact values retain their original strings.
    const observation = JSON.parse(job.registryJson);
    let registry;
    try {
      registry = observation.format === 'macro-native-registry-observation/1'
        ? buildNativeRegistry(job.authoredSource, observation as NativeRegistryObservation)
        : captureRegistry(observation);
    } catch (error) {
      if (!(error instanceof ConformanceError)) throw error;
      // An unsupported authored declaration does not retire the resident host.
      // The real compiler still returns its static report and a closed runtime assessment.
      registry = captureRegistry({ version: observation.version, bindings: [], models: [], configurations: [], mcpTools: [] });
    }
    const result = await compilePlan(job.authoredSource, captureSourceRevision(job.source), registry);
    let entryValidation;
    if (Object.hasOwn(observation, 'startEntry')) {
      const messageJson = observation.startEntry?.messageJson ?? null;
      let valid = false;
      try {
        if (result.plan !== null) {
          if (result.plan.entry === null) valid = observation.startEntry === null;
          else if (typeof messageJson === 'string') {
            normalizeMessage(record(decode(job.authoredSource)), decode(messageJson));
            valid = true;
          }
        }
      } catch (error) { if (!(error instanceof ConformanceError)) throw error; }
      entryValidation = { messageJson, valid };
    }
    let deliveryValidation;
    if (Object.hasOwn(observation, 'deliveryInput')) {
      const input = observation.deliveryInput;
      let valid = false;
      try {
        if (result.plan !== null && result.plan.entry === null && result.plan.agents.some(agent => agent.agentName === input.agentName) && typeof input.messageJson === 'string') {
          normalizeMessage(record(decode(job.authoredSource)), decode(input.messageJson));
          valid = true;
        }
      } catch (error) { if (!(error instanceof ConformanceError)) throw error; }
      deliveryValidation = { input, valid };
    }
    let callValidation;
    if (Object.hasOwn(observation, 'callInput')) {
      const input = observation.callInput;
      let prepared = null;
      try {
        prepared = prepareCall(record(decode(job.authoredSource)), record(decode(input.declarationJson)), input.input, registry);
      } catch (error) { if (!(error instanceof ConformanceError)) throw error; }
      callValidation = { input, prepared };
    }
    const toolPolicy = Object.hasOwn(observation, 'toolPolicyInput')
      ? assessNativeToolPolicy(observation.toolPolicyInput, registry) : undefined;
    await executionHostCompleteCompile(job.ticket, JSON.stringify({ ...result, capturedRegistryJson: JSON.stringify(registry), entryValidation, deliveryValidation, toolPolicy, callValidation }));
  }
}
void start().catch(async () => {
  // Failure revokes this incarnation and its owned systems, without replay.
  await executionHostFailed().catch(() => undefined);
});
