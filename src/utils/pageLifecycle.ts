let pageShuttingDown = false;
const pageLifecycleController = new AbortController();

export const markPageShuttingDown = (reason?: unknown): void => {
  if (pageShuttingDown) {
    return;
  }

  pageShuttingDown = true;
  pageLifecycleController.abort(reason);
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    markPageShuttingDown('beforeunload');
  });

  window.addEventListener('pagehide', () => {
    markPageShuttingDown('pagehide');
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    markPageShuttingDown('hmr-dispose');
  });
}

export const getPageLifecycleSignal = (): AbortSignal => pageLifecycleController.signal;

export const isPageShuttingDown = (): boolean => pageShuttingDown;
