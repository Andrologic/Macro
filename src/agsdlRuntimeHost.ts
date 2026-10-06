import { executionHostReady } from './services/tauriIpc';

// This entry never mounts App or a product view. Native ownership survives main reload.
async function start(): Promise<void> {
  await executionHostReady();
}
void start().catch(() => {
  // A failed handshake grants no authority. Native start remains unavailable.
});
