const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const sentryPath = require.resolve('@sentry/node');
const profilingPath = require.resolve('@sentry/profiling-node');

function loadInstrumentWithStubs({ profilingThrows = false, sampleRates = {} } = {}) {
  delete require.cache[instrumentPath];
  delete require.cache[sentryPath];
  delete require.cache[profilingPath];

  const sentryCalls = { init: null };
  require.cache[sentryPath] = {
    id: sentryPath,
    filename: sentryPath,
    loaded: true,
    exports: {
      init: options => { sentryCalls.init = options; },
      getGlobalScope: () => ({ setAttributes() {} }),
      withScope: undefined,
      captureException: () => {},
      isEnabled: () => false,
      metrics: null,
      startSpan: undefined,
      close: async () => {}
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === '@sentry/profiling-node' && profilingThrows) {
      throw new Error('profiling unavailable');
    }
    return originalLoad.apply(this, arguments);
  };

  const originalEnv = {
    SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE,
    SENTRY_PROFILE_SESSION_SAMPLE_RATE: process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE,
    SENTRY_DSN: process.env.SENTRY_DSN
  };
  if ('SENTRY_TRACES_SAMPLE_RATE' in sampleRates) process.env.SENTRY_TRACES_SAMPLE_RATE = sampleRates.SENTRY_TRACES_SAMPLE_RATE;
  if ('SENTRY_PROFILE_SESSION_SAMPLE_RATE' in sampleRates) process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE = sampleRates.SENTRY_PROFILE_SESSION_SAMPLE_RATE;
  if ('SENTRY_DSN' in sampleRates) process.env.SENTRY_DSN = sampleRates.SENTRY_DSN;

  try {
    const instrument = require(instrumentPath);
    return { instrument, sentryCalls, restore: () => {
      Module._load = originalLoad;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    } };
  } catch (error) {
    Module._load = originalLoad;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    throw error;
  }
}

function loadInstrument() {
  delete require.cache[instrumentPath];
  return require(instrumentPath);
}

test('instrument records metrics and captures errors with tags', () => {
  const instrument = loadInstrument();
  const metricCalls = [];
  const scopeCalls = [];
  const captureCalls = [];

  const original = {
    metrics: instrument.Sentry.metrics,
    isEnabled: instrument.Sentry.isEnabled,
    withScope: instrument.Sentry.withScope,
    captureException: instrument.Sentry.captureException,
    startSpan: instrument.Sentry.startSpan
  };

  instrument.Sentry.isEnabled = () => true;
  instrument.Sentry.metrics = {
    count: (...args) => metricCalls.push(['count', ...args]),
    gauge: (...args) => metricCalls.push(['gauge', ...args]),
    distribution: (...args) => metricCalls.push(['distribution', ...args])
  };
  instrument.Sentry.withScope = callback => callback({ setTags: tags => scopeCalls.push(tags) });
  instrument.Sentry.captureException = error => captureCalls.push(error);
  instrument.Sentry.startSpan = undefined;

  const error = new Error('boom');
  assert.equal(instrument.captureError(error, { foo: 'bar', nested: { a: 1 } }), error);
  instrument.recordCount('metric.count', 2, { a: 1 });
  instrument.recordGauge('metric.gauge', 3, { b: true });
  instrument.recordDistribution('metric.dist', 4, { unit: 'millisecond', attributes: { nested: { a: 1 } } });
  instrument.recordCount('metric.nullish', 1, { keep: 'yes', dropNull: null, dropUndefined: undefined });
  instrument.recordDistribution('metric.no_unit', 5, { attributes: {} });
  assert.equal(instrument.startSpan({}, () => 123), 123);

  assert.equal(captureCalls.length, 1);
  assert.equal(scopeCalls.length, 1);
  assert.equal(metricCalls.length, 5);
  assert.deepEqual(metricCalls[0][3].attributes, { a: 1 });
  assert.deepEqual(metricCalls[1][3].attributes, { b: true });
  assert.deepEqual(metricCalls[2][3].attributes, { nested: '{"a":1}' });
  assert.deepEqual(metricCalls[3][3].attributes, { keep: 'yes' });
  assert.deepEqual(metricCalls[4][3], {});

  instrument.Sentry.metrics = original.metrics;
  instrument.Sentry.isEnabled = original.isEnabled;
  instrument.Sentry.withScope = original.withScope;
  instrument.Sentry.captureException = original.captureException;
  instrument.Sentry.startSpan = original.startSpan;
});

test('instrument captureError falls back without withScope', () => {
  const instrument = loadInstrument();
  const original = {
    withScope: instrument.Sentry.withScope,
    captureException: instrument.Sentry.captureException
  };

  let capturedTags = null;
  instrument.Sentry.withScope = undefined;
  instrument.Sentry.captureException = (_error, options) => {
    capturedTags = options.tags;
  };

  const error = new Error('fallback');
  assert.equal(instrument.captureError(error, { foo: 'bar' }), error);
  assert.deepEqual(capturedTags, { foo: 'bar' });

  instrument.Sentry.withScope = original.withScope;
  instrument.Sentry.captureException = original.captureException;
});

test('instrument falls back when profiling integration is unavailable', () => {
  const { instrument, sentryCalls, restore } = loadInstrumentWithStubs({
    profilingThrows: true,
    sampleRates: {
      SENTRY_TRACES_SAMPLE_RATE: 'not-a-number',
      SENTRY_PROFILE_SESSION_SAMPLE_RATE: 'bad',
      SENTRY_DSN: 'https://example.invalid/1'
    }
  });

  try {
    assert.equal(typeof instrument.captureError, 'function');
    assert.equal(sentryCalls.init.tracesSampleRate, 1);
    assert.equal(sentryCalls.init.profileSessionSampleRate, 1);
    assert.equal(Array.isArray(sentryCalls.init.integrations), true);
  } finally {
    restore();
  }
});

test('instrument no-ops metrics when Sentry is disabled', () => {
  const instrument = loadInstrument();
  const original = {
    isEnabled: instrument.Sentry.isEnabled,
    metrics: instrument.Sentry.metrics
  };

  instrument.Sentry.isEnabled = () => false;
  instrument.Sentry.metrics = {
    count() { throw new Error('should not be called'); },
    gauge() { throw new Error('should not be called'); },
    distribution() { throw new Error('should not be called'); }
  };

  try {
    assert.equal(instrument.closeSentry() instanceof Promise, true);
    instrument.recordCount('metric.count');
    instrument.recordGauge('metric.gauge', 1);
    instrument.recordDistribution('metric.dist', 2);
  } finally {
    instrument.Sentry.isEnabled = original.isEnabled;
    instrument.Sentry.metrics = original.metrics;
  }
});