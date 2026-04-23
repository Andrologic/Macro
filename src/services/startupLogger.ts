type StartupLogLevel = "debug" | "info" | "warn" | "error";

type TauriInvoke = (
  command: string,
  payload?: Record<string, unknown>,
) => Promise<unknown>;

const STARTUP_PREFIX = "[Startup]";
const STARTUP_SCOPE = "startup";

let invokePromise: Promise<TauriInvoke | null> | null = null;
let nativeForwardingFailureReported = false;

const isTauriAvailable = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  const tauriWindow = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke?: unknown;
    } | null;
  };

  return typeof tauriWindow.__TAURI_INTERNALS__?.invoke === "function";
};

const loadInvoke = async (): Promise<TauriInvoke | null> => {
  if (!isTauriAvailable()) {
    return null;
  }

  if (!invokePromise) {
    invokePromise = import("@tauri-apps/api/core")
      .then((module) => module.invoke)
      .catch(() => null);
  }

  return invokePromise;
};

const serializeDetails = (details: unknown): string | null => {
  if (details === undefined) {
    return null;
  }

  if (details instanceof Error) {
    return JSON.stringify({
      name: details.name,
      message: details.message,
      stack: details.stack,
    });
  }

  if (typeof details === "string") {
    return details;
  }

  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
};

const formatMessage = (message: string, details?: unknown): string => {
  const serializedDetails = serializeDetails(details);
  if (!serializedDetails) {
    return `${STARTUP_PREFIX} ${message}`;
  }
  return `${STARTUP_PREFIX} ${message} | ${serializedDetails}`;
};

const writeConsole = (level: StartupLogLevel, message: string): void => {
  switch (level) {
    case "debug":
      console.debug(message);
      return;
    case "warn":
      console.warn(message);
      return;
    case "error":
      console.error(message);
      return;
    default:
      console.info(message);
  }
};

const forwardToNative = (level: StartupLogLevel, message: string): void => {
  void loadInvoke()
    .then((invoke) => {
      if (!invoke) {
        return;
      }
      return invoke("frontend_log", {
        level,
        scope: STARTUP_SCOPE,
        message,
      });
    })
    .catch((error) => {
      if (nativeForwardingFailureReported) {
        return;
      }
      nativeForwardingFailureReported = true;
      console.warn(
        `${STARTUP_PREFIX} Failed to forward frontend logs to native tracing`,
        error,
      );
    });
};

const log = (level: StartupLogLevel, message: string, details?: unknown): void => {
  const formattedMessage = formatMessage(message, details);
  writeConsole(level, formattedMessage);
  forwardToNative(level, formattedMessage);
};

export const startupLogger = {
  debug: (message: string, details?: unknown) => log("debug", message, details),
  info: (message: string, details?: unknown) => log("info", message, details),
  warn: (message: string, details?: unknown) => log("warn", message, details),
  error: (message: string, details?: unknown) => log("error", message, details),
};
