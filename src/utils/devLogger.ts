type DevLogMethod = (...args: unknown[]) => void;

type DevConsoleLike = Pick<Console, 'log' | 'info' | 'debug' | 'warn' | 'error'>;

export interface DevLogger {
  log: DevLogMethod;
  info: DevLogMethod;
  debug: DevLogMethod;
  warn: DevLogMethod;
  error: DevLogMethod;
}

interface CreateDevLoggerOptions {
  enabled?: boolean;
  consoleLike?: DevConsoleLike;
}

export const isDevelopmentBuild = Boolean(import.meta.env?.DEV);

const noop: DevLogMethod = () => undefined;

export const createDevLogger = (options: CreateDevLoggerOptions = {}): DevLogger => {
  const {
    enabled = isDevelopmentBuild,
    consoleLike = console,
  } = options;

  if (!enabled) {
    return {
      log: noop,
      info: noop,
      debug: noop,
      warn: noop,
      error: noop,
    };
  }

  return {
    log: (...args) => consoleLike.log(...args),
    info: (...args) => consoleLike.info(...args),
    debug: (...args) => consoleLike.debug(...args),
    warn: (...args) => consoleLike.warn(...args),
    error: (...args) => consoleLike.error(...args),
  };
};

export const devLogger = createDevLogger();
