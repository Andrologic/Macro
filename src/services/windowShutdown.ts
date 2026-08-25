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

let windowStateFlushHandler: (() => Promise<void>) | null = null;

export const registerWindowStateFlushHandler = (
  handler: () => Promise<void>,
): (() => void) => {
  windowStateFlushHandler = handler;
  return () => {
    if (windowStateFlushHandler === handler) {
      windowStateFlushHandler = null;
    }
  };
};

export const flushWindowStateBeforeShutdown = async (
  timeoutMs = 1_000,
): Promise<void> => {
  const handler = windowStateFlushHandler;
  if (!handler) return;

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      handler(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const prepareForPotentialShutdown = async (
  workspacePaths?: string[],
  timeoutMs = 1_000,
): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.all([
      flushWindowStateBeforeShutdown(timeoutMs),
      Promise.race([
        flushMacroMetadataForShutdown(workspacePaths),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
      ]),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

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

export const prepareWindowShutdown = async (
  reason: string,
  workspacePaths?: string[],
): Promise<void> => {
  await flushWindowStateBeforeShutdown();
  markWindowCloseShutdown(reason, workspacePaths);
};
