const shutdownGateHolders = new Set<symbol>();

export const beginAppShutdownGate = (): (() => void) => {
  const holder = Symbol('app-shutdown');
  shutdownGateHolders.add(holder);
  return () => {
    shutdownGateHolders.delete(holder);
  };
};

export const isAppShutdownGateActive = (): boolean => shutdownGateHolders.size > 0;

export const resetAppShutdownGateForTests = (): void => {
  shutdownGateHolders.clear();
};
