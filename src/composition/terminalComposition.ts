import type { LifecycleContext } from '../services/lifecycleScope';
import { terminalRuntime } from '../services/terminalRuntime';
import { useTerminalStore } from '../stores/useTerminalStore';
import type { TerminalLifecyclePort } from '../services/terminalLifecycle';

/** Install once in the application composition, before Terminal initialization. */
export const createTerminalComposition = (
  store: Pick<typeof useTerminalStore, 'getState'> = useTerminalStore,
  rendering: TerminalLifecyclePort = terminalRuntime,
) => {
  store.getState().setLifecyclePort(rendering);
  return {
    start: (context?: LifecycleContext) => store.getState().startRuntime(context),
    // Releases frontend resources and command waiters, never kills native sessions.
    stop: () => store.getState().stopRuntime(),
  };
};
