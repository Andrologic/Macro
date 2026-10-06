import { executionHostFailed, executionHostCompleteCompile, executionHostNextCompile, executionHostReady } from './services/tauriIpc';
import { compilePlan } from './services/agsdlExecution/compiler';
import { captureSourceRevision } from './services/agsdlExecution/metadata';
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
    const registry = captureRegistry(JSON.parse(job.registryJson));
    const result = await compilePlan(job.authoredSource, captureSourceRevision(job.source), registry);
    await executionHostCompleteCompile(job.ticket, JSON.stringify(result));
  }
}
void start().catch(async () => {
  // Failure revokes this incarnation and its owned systems, without replay.
  await executionHostFailed().catch(() => undefined);
});
