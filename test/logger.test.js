const path = require('path');
const { stubModule, reloadModule } = require('./testUtils.cjs');

const getLogger = require(path.resolve(__dirname, '..', 'logger.js'));

test('should throws on invalid label', () => {
  expect(() => getLogger(null)).toThrow();
});

test('should returns logger with methods', () => {
  const logger = getLogger('test');
  expect(typeof logger.info).toBe('function');
  expect(typeof logger.error).toBe('function');
  expect(typeof logger._pino).toBe('object');
});

// --- appended from test/logger.coverage.test.js ---
const loggerPath = path.resolve(__dirname, '..', 'logger.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const pinoPath = require.resolve('pino');

function loadLoggerWithPino(pinoFactory) {
  global.__pinoStub = Object.assign(pinoFactory, {
    stdTimeFunctions: {
      isoTime: () => new Date().toISOString()
    }
  });
  return reloadModule(loggerPath);
}

test('should logger forwards structured messages to Sentry logger methods (coverage merged)', () => {
  const instrument = require(instrumentPath);
  const sentryCalls = [];
  const original = instrument.Sentry.logger;
  instrument.Sentry.logger = {
    info: (...args) => sentryCalls.push(['info', ...args]),
    error: (...args) => sentryCalls.push(['error', ...args]),
    warn: (...args) => sentryCalls.push(['warn', ...args]),
    debug: (...args) => sentryCalls.push(['debug', ...args]),
    trace: (...args) => sentryCalls.push(['trace', ...args]),
    fatal: (...args) => sentryCalls.push(['fatal', ...args])
  };

  const getLogger = require(loggerPath);
  const logger = getLogger('coverage');
  logger.info('info message', { a: 1 });
  logger.error('error message', { b: 2 });
  logger.warn('warn message');
  logger.debug('debug message', { c: 3 });
  logger.trace('trace message');
  logger.fatal('fatal message', { d: 4 });

  expect(sentryCalls.length).toBe(6);
  expect(sentryCalls[0][0]).toBe('info');
  expect(sentryCalls[5][0]).toBe('fatal');

  instrument.Sentry.logger = original;
});

test('should sanitizeMetaForSentry returns non-object metadata unchanged', () => {
  expect(getLogger.sanitizeMetaForSentry(null)).toBe(null);
  expect(getLogger.sanitizeMetaForSentry('plain')).toBe('plain');
});

test('should logger redacts PII fields from Sentry metadata', () => {
  const sentryCalls = [];
  const getLoggerReloaded = reloadModule(loggerPath, () => {
    stubModule(instrumentPath, {
      Sentry: {
        logger: {
          info: (_message, meta) => sentryCalls.push(meta)
        }
      }
    });
    stubModule(path.resolve(__dirname, '..', 'config.js'), { logLevel: 'info' });
  });

  const logger = getLoggerReloaded('pii');
  logger.info('Message received.', { user: 'User#0001', guildList: 'secret', channelName: 'general', userId: '1' });

  expect(sentryCalls[0].user).toBeUndefined();
  expect(sentryCalls[0].guildList).toBeUndefined();
  expect(sentryCalls[0].channelName).toBeUndefined();
  expect(sentryCalls[0].userId).toBe('1');
});

test('should logger swallows Sentry forwarding failures (coverage merged)', () => {
  const instrument = require(instrumentPath);
  const original = instrument.Sentry.logger;
  instrument.Sentry.logger = {
    info: () => { throw new Error('forward failed'); }
  };

  const getLogger = require(loggerPath);
  const logger = getLogger('coverage-forward-failure');
  expect(() => logger.info('message')).not.toThrow();

  instrument.Sentry.logger = original;
});

test('should logger pino level formatter uppercases labels', () => {
  let capturedFormatter;
  loadLoggerWithPino(opts => {
    capturedFormatter = opts.formatters.level;
    return { child: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} }) };
  });
  expect(capturedFormatter('debug')).toEqual({ level: 'DEBUG' });
});

test('should logger surfaces creation failures (coverage merged)', () => {
  const captureException = jest.fn();
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const getLogger = reloadModule(loggerPath, () => {
      stubModule(instrumentPath, { Sentry: { captureException } });
      global.__pinoStub = Object.assign(
        () => ({ child: () => { throw new Error('child failed'); } }),
        { stdTimeFunctions: { isoTime: () => new Date().toISOString() } }
      );
      stubModule(pinoPath, global.__pinoStub);
    });
    expect(() => getLogger('broken')).toThrow(/Failed to create logger instance/);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      { tags: { source: 'logger', handler: 'createLogger' } }
    );
  } finally {
    errorSpy.mockRestore();
  }
});
