const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const loggerPath = path.resolve(__dirname, '..', 'logger.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const pinoPath = require.resolve('pino');

function loadLoggerWithPino(pinoFactory) {
  delete require.cache[loggerPath];
  delete require.cache[pinoPath];
  const fakePino = Object.assign(pinoFactory, {
    stdTimeFunctions: {
      isoTime: () => new Date().toISOString()
    }
  });
  require.cache[pinoPath] = {
    id: pinoPath,
    filename: pinoPath,
    loaded: true,
    exports: fakePino
  };
  return require(loggerPath);
}

test('logger forwards structured messages to Sentry logger methods', () => {
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

  assert.equal(sentryCalls.length, 6);
  assert.equal(sentryCalls[0][0], 'info');
  assert.equal(sentryCalls[5][0], 'fatal');

  instrument.Sentry.logger = original;
});

test('logger swallows Sentry forwarding failures', () => {
  const instrument = require(instrumentPath);
  const original = instrument.Sentry.logger;
  instrument.Sentry.logger = {
    info: () => { throw new Error('forward failed'); }
  };

  const getLogger = require(loggerPath);
  const logger = getLogger('coverage-forward-failure');
  assert.doesNotThrow(() => logger.info('message'));

  instrument.Sentry.logger = original;
});

test('logger surfaces creation failures', () => {
  const getLogger = loadLoggerWithPino(() => ({ child: () => { throw new Error('child failed'); } }));
  assert.throws(() => getLogger('broken'), /Failed to create logger instance/);
});