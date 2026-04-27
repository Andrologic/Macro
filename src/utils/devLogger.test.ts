import { describe, expect, it, mock } from 'bun:test';
import { createDevLogger } from './devLogger';

describe('devLogger', () => {
  it('delegates console methods when enabled', () => {
    const consoleLike = {
      log: mock(() => undefined),
      info: mock(() => undefined),
      debug: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    };
    const logger = createDevLogger({ enabled: true, consoleLike });

    logger.log('log message', 1);
    logger.info('info message', 2);
    logger.debug('debug message', 3);
    logger.warn('warn message', 4);
    logger.error('error message', 5);

    expect(consoleLike.log).toHaveBeenCalledWith('log message', 1);
    expect(consoleLike.info).toHaveBeenCalledWith('info message', 2);
    expect(consoleLike.debug).toHaveBeenCalledWith('debug message', 3);
    expect(consoleLike.warn).toHaveBeenCalledWith('warn message', 4);
    expect(consoleLike.error).toHaveBeenCalledWith('error message', 5);
  });

  it('stays silent when disabled', () => {
    const consoleLike = {
      log: mock(() => undefined),
      info: mock(() => undefined),
      debug: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    };
    const logger = createDevLogger({ enabled: false, consoleLike });

    logger.log('log message');
    logger.info('info message');
    logger.debug('debug message');
    logger.warn('warn message');
    logger.error('error message');

    expect(consoleLike.log).not.toHaveBeenCalled();
    expect(consoleLike.info).not.toHaveBeenCalled();
    expect(consoleLike.debug).not.toHaveBeenCalled();
    expect(consoleLike.warn).not.toHaveBeenCalled();
    expect(consoleLike.error).not.toHaveBeenCalled();
  });
});
