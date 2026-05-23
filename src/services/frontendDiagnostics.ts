import type { FrontendLogLevel, FrontendLogParams } from './tauriIpc';

type FrontendLogForwarder = (params: FrontendLogParams) => void | Promise<void>;
export type { FrontendLogParams };

interface InstallFrontendDiagnosticsOptions {
  windowRef?: Window;
  forwardLog?: FrontendLogForwarder;
  consoleLike?: Pick<Console, 'error' | 'warn'>;
  isDev?: boolean;
  reloadPage?: () => void;
  scheduleReload?: (run: () => void) => void;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

type DiagnosticWindow = Window & {
  __MACRO_FRONTEND_DIAGNOSTICS_UNINSTALL__?: (() => void) | null;
};

const DIAGNOSTIC_SCOPE = 'frontend';
const MAX_LOG_MESSAGE_LENGTH = 8_000;
const VITE_OPTIMIZE_DEP_RELOAD_KEY = 'macro:vite-optimize-dep-reload';

const defaultForwardLog: FrontendLogForwarder = (params) => {
  void import('./tauriIpc')
    .then(({ frontendLog }) => frontendLog(params))
    .catch(() => undefined);
};

const truncate = (value: string, maxLength = MAX_LOG_MESSAGE_LENGTH): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;

const serializeError = (error: unknown): string | null => {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return [
      error.name ? `name=${error.name}` : null,
      error.message ? `message=${error.message}` : null,
      error.stack ? `stack=${error.stack}` : null,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const getElementResource = (target: EventTarget | null): string | null => {
  const elementConstructor = typeof Element === 'undefined' ? null : Element;
  if (!elementConstructor || !(target instanceof elementConstructor)) {
    return null;
  }

  const resource =
    target.getAttribute('src') ||
    target.getAttribute('href') ||
    target.getAttribute('data-src');

  if (resource) {
    return resource;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName ? `<${tagName}>` : null;
};

export const createFrontendDiagnosticMessage = (
  kind: string,
  details: Record<string, unknown>,
): string => {
  const fields = Object.entries(details)
    .map(([key, value]) => {
      if (value === null || value === undefined || value === '') {
        return null;
      }
      return `${key}=${String(value)}`;
    })
    .filter(Boolean);

  return truncate(`[Frontend:${kind}] ${fields.join(' ')}`);
};

const safeForward = (
  forwardLog: FrontendLogForwarder,
  consoleLike: Pick<Console, 'warn'>,
  level: FrontendLogLevel,
  message: string,
): void => {
  try {
    void Promise.resolve(
      forwardLog({
        level,
        scope: DIAGNOSTIC_SCOPE,
        message,
      }),
    ).catch(() => undefined);
  } catch (error) {
    consoleLike.warn('[FrontendDiagnostics] Failed to forward frontend diagnostic', error);
  }
};

const looksLikeViteOptimizedDepFailure = (message: string): boolean =>
  message.includes('Importing a module script failed') &&
  message.includes('/node_modules/.vite/deps/');

const maybeReloadAfterViteOptimizedDepFailure = (
  message: string,
  options: Required<
    Pick<
      InstallFrontendDiagnosticsOptions,
      'isDev' | 'reloadPage' | 'scheduleReload' | 'storage'
    >
  >,
): boolean => {
  if (!options.isDev || !looksLikeViteOptimizedDepFailure(message)) {
    return false;
  }

  try {
    if (options.storage.getItem(VITE_OPTIMIZE_DEP_RELOAD_KEY) === '1') {
      return false;
    }

    options.storage.setItem(VITE_OPTIMIZE_DEP_RELOAD_KEY, '1');
  } catch {
    return false;
  }

  options.scheduleReload(() => {
    options.reloadPage();
  });
  return true;
};

export const installFrontendDiagnostics = (
  options: InstallFrontendDiagnosticsOptions = {},
): (() => void) => {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const windowRef = (options.windowRef ?? window) as DiagnosticWindow;
  const forwardLog = options.forwardLog ?? defaultForwardLog;
  const consoleLike = options.consoleLike ?? console;
  const reloadOptions = {
    isDev: options.isDev ?? Boolean(import.meta.env?.DEV),
    reloadPage: options.reloadPage ?? (() => windowRef.location.reload()),
    scheduleReload:
      options.scheduleReload ??
      ((run: () => void) => {
        windowRef.setTimeout(run, 100);
      }),
    storage: options.storage ?? windowRef.sessionStorage,
  };

  windowRef.__MACRO_FRONTEND_DIAGNOSTICS_UNINSTALL__?.();

  const handleError = (event: ErrorEvent | Event) => {
    const errorEvent = event as ErrorEvent;
    const resource = getElementResource(event.target);
    const message = createFrontendDiagnosticMessage('error', {
      message: errorEvent.message || (resource ? 'Resource failed to load' : 'Unknown error'),
      filename: errorEvent.filename,
      lineno: errorEvent.lineno,
      colno: errorEvent.colno,
      resource,
      error: serializeError(errorEvent.error),
    });

    consoleLike.error(message);
    safeForward(forwardLog, consoleLike, 'error', message);
    maybeReloadAfterViteOptimizedDepFailure(message, reloadOptions);
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent | Event) => {
    const rejectionEvent = event as PromiseRejectionEvent;
    const message = createFrontendDiagnosticMessage('unhandledrejection', {
      reason: serializeError(rejectionEvent.reason),
    });

    consoleLike.error(message);
    safeForward(forwardLog, consoleLike, 'error', message);
  };

  const handleVitePreloadError = (event: Event) => {
    const preloadEvent = event as Event & { payload?: unknown };
    const message = createFrontendDiagnosticMessage('preloadError', {
      reason: serializeError(preloadEvent.payload),
    });

    consoleLike.error(message);
    safeForward(forwardLog, consoleLike, 'error', message);

    if (maybeReloadAfterViteOptimizedDepFailure(message, reloadOptions)) {
      event.preventDefault();
    }
  };

  windowRef.addEventListener('error', handleError, true);
  windowRef.addEventListener('unhandledrejection', handleUnhandledRejection);
  windowRef.addEventListener('vite:preloadError', handleVitePreloadError);

  const uninstall = () => {
    windowRef.removeEventListener('error', handleError, true);
    windowRef.removeEventListener('unhandledrejection', handleUnhandledRejection);
    windowRef.removeEventListener('vite:preloadError', handleVitePreloadError);
    if (windowRef.__MACRO_FRONTEND_DIAGNOSTICS_UNINSTALL__ === uninstall) {
      windowRef.__MACRO_FRONTEND_DIAGNOSTICS_UNINSTALL__ = null;
    }
  };

  windowRef.__MACRO_FRONTEND_DIAGNOSTICS_UNINSTALL__ = uninstall;
  return uninstall;
};
