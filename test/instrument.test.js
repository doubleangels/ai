const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const instrument = require(path.resolve(__dirname, '..', 'instrument.js'));

test('captureError returns the error object', () => {
  const err = new Error('boom');
  const res = instrument.captureError(err, { foo: 'bar' });
  assert.equal(res, err);
});

test('startSpan executes callback and returns its value', async () => {
  const val = await instrument.startSpan({ op: 'test' }, async () => {
    return 42;
  });
  assert.equal(val, 42);
});

test('recordCount does not throw', () => {
  assert.doesNotThrow(() => instrument.recordCount('test.metric', 1, { a: 1 }));
});

// --- appended from test/instrument.coverage.test.js ---
const Module = require('module');

const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const sentryPath = require.resolve('@sentry/node');
const profilingPath = require.resolve('@sentry/profiling-node');

function loadInstrumentWithStubs({ profilingThrows = false, sampleRates = {}, omitGlobalScope = false } = {}) {
  delete require.cache[instrumentPath];
  delete require.cache[sentryPath];
  delete require.cache[profilingPath];

  const sentryCalls = { init: null, closeArgs: null };
  const sentryExports = {
    init: options => { sentryCalls.init = options; },
    withScope: undefined,
    captureException: () => {},
    isEnabled: () => false,
    metrics: null,
    startSpan: undefined,
    close: async (...args) => { sentryCalls.closeArgs = args; }
  };
  if (!omitGlobalScope) {
    sentryExports.getGlobalScope = () => ({ setAttributes() {} });
  }

  require.cache[sentryPath] = {
    id: sentryPath,
    filename: sentryPath,
    loaded: true,
    exports: sentryExports
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === '@sentry/profiling-node' && profilingThrows) {
      throw new Error('profiling unavailable');
    }
    return originalLoad.apply(this, arguments);
  };

  const envKeys = [
    'SENTRY_TRACES_SAMPLE_RATE',
    'SENTRY_PROFILE_SESSION_SAMPLE_RATE',
    'SENTRY_DSN',
    'SENTRY_ENABLE_LOGS',
    'SENTRY_ENABLE_METRICS',
    'SENTRY_PROFILE_LIFECYCLE'
  ];
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) {
    if (key in sampleRates) {
      process.env[key] = sampleRates[key];
    }
  }

  try {
    const instrument = require(instrumentPath);
    return { instrument, sentryCalls, restore: () => {
      Module._load = originalLoad;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      delete require.cache[instrumentPath];
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

test('instrument records metrics and captures errors with tags (coverage merged)', () => {
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

test('instrument captureError falls back without withScope (coverage merged)', () => {
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

test('instrument falls back when profiling integration is unavailable (coverage merged)', () => {
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

test('instrument clamps valid sample rates from environment', () => {
  const { sentryCalls, restore } = loadInstrumentWithStubs({
    sampleRates: {
      SENTRY_TRACES_SAMPLE_RATE: '0.25',
      SENTRY_PROFILE_SESSION_SAMPLE_RATE: '2',
      SENTRY_DSN: 'https://example.invalid/1'
    }
  });

  try {
    assert.equal(sentryCalls.init.tracesSampleRate, 0.25);
    assert.equal(sentryCalls.init.profileSessionSampleRate, 1);
  } finally {
    restore();
  }
});

test('instrument handles profiling integration that throws when invoked', () => {
  delete require.cache[instrumentPath];
  delete require.cache[sentryPath];
  delete require.cache[profilingPath];

  require.cache[profilingPath] = {
    id: profilingPath,
    filename: profilingPath,
    loaded: true,
    exports: {
      nodeProfilingIntegration: () => {
        throw new Error('integration init failed');
      }
    }
  };

  const originalDsn = process.env.SENTRY_DSN;
  process.env.SENTRY_DSN = 'https://example.invalid/1';

  const stderrSpy = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = chunk => {
    stderrSpy.push(String(chunk));
    return true;
  };

  try {
    const loaded = require(instrumentPath);
    assert.equal(typeof loaded.captureError, 'function');
    assert.match(stderrSpy.join(''), /profiling integration unavailable/);
  } finally {
    process.stderr.write = originalWrite;
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
    delete require.cache[instrumentPath];
    delete require.cache[profilingPath];
  }
});

test('instrument no-ops metrics when Sentry is disabled (coverage merged)', () => {
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

test('instrument disables logs and metrics when env flags are false', () => {
  const { sentryCalls, restore } = loadInstrumentWithStubs({
    sampleRates: {
      SENTRY_DSN: 'https://example.invalid/1',
      SENTRY_ENABLE_LOGS: 'false',
      SENTRY_ENABLE_METRICS: 'false'
    }
  });

  try {
    assert.equal(sentryCalls.init.enableLogs, false);
    assert.equal(sentryCalls.init.enableMetrics, false);
  } finally {
    restore();
  }
});

test('instrument honors SENTRY_PROFILE_LIFECYCLE env', () => {
  const { sentryCalls, restore } = loadInstrumentWithStubs({
    sampleRates: {
      SENTRY_DSN: 'https://example.invalid/1',
      SENTRY_PROFILE_LIFECYCLE: 'manual'
    }
  });

  try {
    assert.equal(sentryCalls.init.profileLifecycle, 'manual');
  } finally {
    restore();
  }
});

test('instrument loads when getGlobalScope is unavailable', () => {
  const { instrument, restore } = loadInstrumentWithStubs({
    omitGlobalScope: true,
    sampleRates: { SENTRY_DSN: 'https://example.invalid/1' }
  });

  try {
    assert.equal(typeof instrument.captureError, 'function');
  } finally {
    restore();
  }
});

test('closeSentry invokes Sentry.close with timeout', async () => {
  const { instrument, sentryCalls, restore } = loadInstrumentWithStubs({
    sampleRates: { SENTRY_DSN: 'https://example.invalid/1' }
  });

  try {
    await instrument.closeSentry();
    assert.deepEqual(sentryCalls.closeArgs, [2000]);
  } finally {
    restore();
  }
});
