let pageShuttingDown = false;
const pageLifecycleController = new AbortController();

export const markPageShuttingDown = (reason?: unknown): void => {
  if (pageShuttingDown) {
    return;
  }

  pageShuttingDown = true;
  pageLifecycleController.abort(reason);
};

const handleBeforeUnload = (): void => {
  markPageShuttingDown('beforeunload');
};

const handlePageHide = (): void => {
  markPageShuttingDown('pagehide');
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', handleBeforeUnload);
  window.addEventListener('pagehide', handlePageHide);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
    }
    markPageShuttingDown('hmr-dispose');
  });
}

export const getPageLifecycleSignal = (): AbortSignal => pageLifecycleController.signal;

export const isPageShuttingDown = (): boolean => pageShuttingDown;
