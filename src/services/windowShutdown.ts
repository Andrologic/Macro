import { devLogger } from '../utils/devLogger';
import { isPageShuttingDown, markPageShuttingDown } from '../utils/pageLifecycle';
import {
  flushMacroMetadata,
  flushPendingMacroMetadata,
} from './macroMetadataCoordinator';

const normalizeWorkspacePaths = (workspacePaths?: string[]): string[] =>
  Array.from(
    new Set(
      (workspacePaths ?? [])
        .map((workspacePath) => workspacePath.trim())
        .filter(Boolean)
    )
  );

const flushMacroMetadataForShutdown = async (workspacePaths?: string[]): Promise<void> => {
  const normalizedWorkspacePaths = normalizeWorkspacePaths(workspacePaths);
  if (normalizedWorkspacePaths.length > 0) {
    await flushMacroMetadata({
      trigger: 'app_close',
      workspacePaths: normalizedWorkspacePaths,
    });
  }
  await flushPendingMacroMetadata('app_close');
};

export const markWindowCloseShutdown = (
  reason = 'window-close-requested',
  workspacePaths?: string[]
): void => {
  if (isPageShuttingDown()) {
    return;
  }

  devLogger.log(`Window shutdown requested: ${reason}`);
  void flushMacroMetadataForShutdown(workspacePaths).catch((error) => {
    devLogger.warn(
      JSON.stringify({
        event: 'macro_metadata_flush_on_window_shutdown_failed',
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
    );
  });
  markPageShuttingDown(reason);
};
