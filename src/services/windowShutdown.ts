import { devLogger } from '../utils/devLogger';
import { isPageShuttingDown, markPageShuttingDown } from '../utils/pageLifecycle';

export const markWindowCloseShutdown = (reason = 'window-close-requested'): void => {
  if (isPageShuttingDown()) {
    return;
  }

  devLogger.log(`Window shutdown requested: ${reason}`);
  markPageShuttingDown(reason);
};
