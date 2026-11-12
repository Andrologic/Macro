import { compileHost030 } from './services/agsdlExecution/hostCompilation';
import { createHostRoutePort030 } from './services/agsdlExecution/hostRouteBroker030';
import { createHostWorkPort030 } from './services/agsdlExecution/hostWorkPort030';
import { runHostWorkPump030 } from './services/agsdlExecution/hostWorkPump030';
import { captureSourceRevision } from './services/agsdlExecution/metadata';
import { connectValueSchemaValidator030 } from './services/agsdlExecution/valueSchemaPort030';
import { executionHostCompleteCompile,executionHostFailed,executionHostNextCompile,executionHostReady } from './services/tauriIpc';
import { NumberToken,parse } from './vendor/agsdl/v0.3/json.mjs';
import { validate } from './vendor/agsdl/v0.3/valueschema.mjs';

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
  const validator = connectValueSchemaValidator030({ NumberToken, parse, validate });
  void runHostWorkPump030(createHostWorkPort030(generation, validator)).catch(async () => {
    await executionHostFailed().catch(() => undefined);
  });
  void runHostWorkPump030(createHostRoutePort030(generation)).catch(async () => {
    await executionHostFailed().catch(() => undefined);
  });
  for (;;) {
      const job = await executionHostNextCompile();
      if (job.generation !== generation) throw new Error('Compiler generation changed.');
      // Only the registry transport envelope uses ordinary JSON. Authored source,
      // declarations, schemas, settings and exact values retain their original strings.
      const observation = JSON.parse(job.registryJson);
      if (observation.format !== 'macro-agsdl-registry/030') throw new Error('Unsupported AgSDL registry edition.');
      const encoded = await compileHost030(job.authoredSource, captureSourceRevision(job.source), observation);
      await executionHostCompleteCompile(job.ticket, encoded);
  }
}
void start().catch(async () => {
  await executionHostFailed().catch(() => undefined);
});
