import type { LifecycleContext } from '../services/lifecycleScope';
import { terminalRenderingLifecycle } from '../services/terminalRenderingLifecycle';
import { useTerminalStore } from '../stores/useTerminalStore';

/** Install once in the application composition, before Terminal initialization. */
export const createTerminalComposition = (
  store: Pick<typeof useTerminalStore, 'getState'> = useTerminalStore,
  rendering = terminalRenderingLifecycle,
) => {
  let owner: ReturnType<typeof rendering.install> | null = rendering.install();
  store.getState().setLifecyclePort(owner);
  return {
    start: (context?: LifecycleContext) => {
      context?.assertActive();
      if (!owner) {
        owner = rendering.install();
        store.getState().setLifecyclePort(owner);
      }
      return store.getState().startRuntime(context);
    },
    // Releases frontend resources and command waiters, never kills native sessions.
    stop: () => {
      owner?.stop();
      owner = null;
      return store.getState().stopRuntime();
    },
  };
};
