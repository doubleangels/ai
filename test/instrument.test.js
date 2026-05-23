const path = require('path');

const instrument = require(path.resolve(__dirname, '..', 'instrument.js'));

test('should returns the error object', () => {
  const err = new Error('boom');
  const res = instrument.captureError(err, { foo: 'bar' });
  expect(res).toBe(err);
});

test('should executes callback and returns its value', async () => {
  const val = await instrument.startSpan({ op: 'test' }, async () => {
    return 42;
  });
  expect(val).toBe(42);
});

test('should does not throw', () => {
  expect(() => instrument.recordCount('test.metric', 1, { a: 1 })).not.toThrow();
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

  const envKeys = [
    'SENTRY_TRACES_SAMPLE_RATE',
    'SENTRY_PROFILE_SESSION_SAMPLE_RATE',
    'SENTRY_DSN',
    'SENTRY_ENABLE_LOGS',
    'SENTRY_ENABLE_METRICS',
    'SENTRY_PROFILE_LIFECYCLE',
    'NODE_ENV'
  ];
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) {
    if (key in sampleRates) {
      process.env[key] = sampleRates[key];
    }
  }

  let instrument;
  jest.isolateModules(() => {
    jest.doMock('@sentry/node', () => sentryExports);
    if (profilingThrows) {
      jest.doMock('@sentry/profiling-node', () => {
        throw new Error('profiling unavailable');
      });
    } else {
      jest.doMock('@sentry/profiling-node', () => ({
        nodeProfilingIntegration: () => () => {}
      }));
    }
    instrument = require(instrumentPath);
  });

  return {
    instrument,
    sentryCalls,
    restore: () => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete require.cache[instrumentPath];
    }
  };
}

function loadInstrument() {
  delete require.cache[instrumentPath];
  return require(instrumentPath);
}

test('should records metrics and captures errors with tags (coverage merged)', () => {
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
  expect(instrument.captureError(error, { foo: 'bar', nested: { a: 1 } })).toBe(error);
  instrument.recordCount('metric.count', 2, { a: 1 });
  instrument.recordGauge('metric.gauge', 3, { b: true });
  instrument.recordDistribution('metric.dist', 4, { unit: 'millisecond', attributes: { nested: { a: 1 } } });
  instrument.recordCount('metric.nullish', 1, { keep: 'yes', dropNull: null, dropUndefined: undefined });
  instrument.recordDistribution('metric.no_unit', 5, { attributes: {} });
  expect(instrument.startSpan({}, () => 123)).toBe(123);

  expect(captureCalls.length).toBe(1);
  expect(scopeCalls.length).toBe(1);
  expect(metricCalls.length).toBe(5);
  expect(metricCalls[0][3].attributes).toEqual({ a: 1 });
  expect(metricCalls[1][3].attributes).toEqual({ b: true });
  expect(metricCalls[2][3].attributes).toEqual({ nested: '{"a":1}' });
  expect(metricCalls[3][3].attributes).toEqual({ keep: 'yes' });
  expect(metricCalls[4][3]).toEqual({});

  instrument.Sentry.metrics = original.metrics;
  instrument.Sentry.isEnabled = original.isEnabled;
  instrument.Sentry.withScope = original.withScope;
  instrument.Sentry.captureException = original.captureException;
  instrument.Sentry.startSpan = original.startSpan;
});

test('should captureError falls back without withScope (coverage merged)', () => {
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
  expect(instrument.captureError(error, { foo: 'bar' })).toBe(error);
  expect(capturedTags).toEqual({ foo: 'bar' });

  instrument.Sentry.withScope = original.withScope;
  instrument.Sentry.captureException = original.captureException;
});

test('should falls back when profiling integration is unavailable (coverage merged)', () => {
  const { instrument, sentryCalls, restore } = loadInstrumentWithStubs({
    profilingThrows: true,
    sampleRates: {
      SENTRY_TRACES_SAMPLE_RATE: 'not-a-number',
      SENTRY_PROFILE_SESSION_SAMPLE_RATE: 'bad',
      SENTRY_DSN: 'https://example.invalid/1'
    }
  });

  try {
    expect(typeof instrument.captureError).toBe('function');
    expect(sentryCalls.init.tracesSampleRate).toBe(1);
    expect(sentryCalls.init.profileSessionSampleRate).toBe(1);
    expect(Array.isArray(sentryCalls.init.integrations)).toBe(true);
  } finally {
    restore();
  }
});

test('should clamps valid sample rates from environment', () => {
  const { sentryCalls, restore } = loadInstrumentWithStubs({
    sampleRates: {
      SENTRY_TRACES_SAMPLE_RATE: '0.25',
      SENTRY_PROFILE_SESSION_SAMPLE_RATE: '2',
      SENTRY_DSN: 'https://example.invalid/1'
    }
  });

  try {
    expect(sentryCalls.init.tracesSampleRate).toBe(0.25);
    expect(sentryCalls.init.profileSessionSampleRate).toBe(1);
  } finally {
    restore();
  }
});

test('should handles profiling integration that throws when invoked', () => {
  delete require.cache[instrumentPath];
  delete require.cache[sentryPath];
  delete require.cache[profilingPath];

  const sentryExports = {
    init: () => {},
    withScope: undefined,
    captureException: () => {},
    isEnabled: () => false,
    metrics: null,
    startSpan: undefined,
    close: async () => {},
    getGlobalScope: () => ({ setAttributes() {} })
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
    let loaded;
    jest.isolateModules(() => {
      jest.doMock('@sentry/node', () => sentryExports);
      jest.doMock('@sentry/profiling-node', () => ({
        nodeProfilingIntegration: () => {
          throw new Error('integration init failed');
        }
      }));
      loaded = require(instrumentPath);
    });
    expect(typeof loaded.captureError).toBe('function');
    expect(stderrSpy.join('')).toMatch(/profiling integration unavailable/);
  } finally {
    process.stderr.write = originalWrite;
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
    delete require.cache[instrumentPath];
    delete require.cache[profilingPath];
  }
});

test('should no-ops metrics when Sentry is disabled (coverage merged)', () => {
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
    expect(instrument.closeSentry() instanceof Promise).toBe(true);
    instrument.recordCount('metric.count');
    instrument.recordGauge('metric.gauge', 1);
    instrument.recordDistribution('metric.dist', 2);
  } finally {
    instrument.Sentry.isEnabled = original.isEnabled;
    instrument.Sentry.metrics = original.metrics;
  }
});

test('should disables logs and metrics when env flags are false', () => {
  const { sentryCalls, restore } = loadInstrumentWithStubs({
    sampleRates: {
      SENTRY_DSN: 'https://example.invalid/1',
      SENTRY_ENABLE_LOGS: 'false',
      SENTRY_ENABLE_METRICS: 'false'
    }
  });

  try {
    expect(sentryCalls.init.enableLogs).toBe(false);
    expect(sentryCalls.init.enableMetrics).toBe(false);
  } finally {
    restore();
  }
});

test('should honors SENTRY_PROFILE_LIFECYCLE env', () => {
  const { sentryCalls, restore } = loadInstrumentWithStubs({
    sampleRates: {
      SENTRY_DSN: 'https://example.invalid/1',
      SENTRY_PROFILE_LIFECYCLE: 'manual'
    }
  });

  try {
    expect(sentryCalls.init.profileLifecycle).toBe('manual');
  } finally {
    restore();
  }
});

test('should loads when getGlobalScope is unavailable', () => {
  const { instrument, restore } = loadInstrumentWithStubs({
    omitGlobalScope: true,
    sampleRates: { SENTRY_DSN: 'https://example.invalid/1' }
  });

  try {
    expect(typeof instrument.captureError).toBe('function');
  } finally {
    restore();
  }
});

test('should uses NODE_ENV in Sentry init when set', () => {
  const { sentryCalls, restore } = loadInstrumentWithStubs({
    sampleRates: {
      SENTRY_DSN: 'https://example.invalid/1',
      NODE_ENV: 'staging'
    }
  });

  try {
    expect(sentryCalls.init.environment).toBe('staging');
  } finally {
    restore();
  }
});

test('should defaults environment to production when NODE_ENV is unset', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;

  const { sentryCalls, restore } = loadInstrumentWithStubs({
    sampleRates: { SENTRY_DSN: 'https://example.invalid/1' }
  });

  try {
    expect(sentryCalls.init.environment).toBe('production');
  } finally {
    restore();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test('should closeSentry invokes Sentry.close with timeout', async () => {
  const { instrument, sentryCalls, restore } = loadInstrumentWithStubs({
    sampleRates: { SENTRY_DSN: 'https://example.invalid/1' }
  });

  try {
    await instrument.closeSentry();
    expect(sentryCalls.closeArgs).toEqual([2000]);
  } finally {
    restore();
  }
});
