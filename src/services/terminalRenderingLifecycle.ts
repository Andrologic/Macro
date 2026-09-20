import type { TerminalLifecyclePort } from './terminalLifecycle';

interface TerminalRenderingOwner extends TerminalLifecyclePort {
  acquire(renderer: TerminalLifecyclePort): boolean;
  stop(): void;
}

/** A terminal-only bridge: importing it never loads the renderer. */
export const createTerminalRenderingLifecycle = () => {
  let current: TerminalRenderingOwner | null = null;

  function install(): TerminalRenderingOwner {
    current?.stop();
    let active = true;
    let renderer: TerminalLifecyclePort | null = null;
    const owner = {
      acquire(candidate: TerminalLifecyclePort) {
        if (!active) {
          candidate.disposeAll();
          return false;
        }
        if (renderer !== candidate) {
          owner.disposeAll();
          renderer = candidate;
        }
        return true;
      },
      disposeTab(tabId: string) { renderer?.disposeTab(tabId); },
      disposeAll() {
        const previous = renderer;
        renderer = null;
        previous?.disposeAll();
      },
      stop() {
        if (!active) return;
        active = false;
        if (current === owner) current = null;
        owner.disposeAll();
      },
    };
    current = owner;
    return owner;
  }

  return {
    install,
    acquire(renderer: TerminalLifecyclePort) {
      if (current) return current.acquire(renderer);
      renderer.disposeAll();
      return false;
    },
  };
};

export const terminalRenderingLifecycle = createTerminalRenderingLifecycle();
