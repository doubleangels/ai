/**
 * Sentry must load before other application modules.
 * Set SENTRY_DSN in the environment to enable reporting.
 */
require('dotenv').config();

const Sentry = require('@sentry/node');
let nodeProfilingIntegration;

try {
  ({ nodeProfilingIntegration } = require('@sentry/profiling-node'));
} catch {
  nodeProfilingIntegration = null;
}

const pkg = require('./package.json');

function parseSampleRate(value, fallback) {
  const parsed = Number.parseFloat(value);
  if (Number.isFinite(parsed)) {
    return Math.min(1, Math.max(0, parsed));
  }
  return fallback;
}

function normalizeAttributes(attributes = {}) {
  const normalized = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = value;
      continue;
    }
    normalized[key] = JSON.stringify(value);
  }

  return normalized;
}

const integrations = [];
if (typeof nodeProfilingIntegration === 'function') {
  try {
    integrations.push(nodeProfilingIntegration());
  } catch (error) {
    process.stderr.write(`[sentry] profiling integration unavailable: ${error.message}\n`);
  }
}

const environment = process.env.NODE_ENV || 'production';
const isProduction = environment === 'production';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === 'true' || process.env.SENTRY_SEND_DEFAULT_PII === '1',
  tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, isProduction ? 0.1 : 1.0),
  enableLogs: process.env.SENTRY_ENABLE_LOGS !== 'false',
  enableMetrics: process.env.SENTRY_ENABLE_METRICS !== 'false',
  profileSessionSampleRate: parseSampleRate(process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE, isProduction ? 0.1 : 1.0),
  profileLifecycle: process.env.SENTRY_PROFILE_LIFECYCLE || 'trace',
  includeLocalVariables: !isProduction,
  environment,
  release: `${pkg.name}@${pkg.version}`,
  integrations
});

if (typeof Sentry.getGlobalScope === 'function') {
  Sentry.getGlobalScope().setAttributes({
    service: pkg.name,
    service_version: pkg.version,
    runtime: 'node',
    platform: process.platform
  });
}

function captureError(error, tags = {}) {
  if (Sentry && typeof Sentry.withScope === 'function') {
    Sentry.withScope(scope => {
      if (tags && typeof tags === 'object') {
        scope.setTags(
          Object.fromEntries(
            Object.entries(tags).map(([key, value]) => [key, String(value)])
          )
        );
      }
      Sentry.captureException(error);
    });
  } else if (Sentry && typeof Sentry.captureException === 'function') {
    Sentry.captureException(error, { tags });
  }
  return error;
}

function recordMetric(metricType, name, value, options = {}) {
  if (!Sentry.isEnabled() || !Sentry.metrics) return;

  const metricOptions = {};
  if (options.unit) {
    metricOptions.unit = options.unit;
  }

  const attributes = normalizeAttributes(options.attributes || {});
  if (Object.keys(attributes).length > 0) {
    metricOptions.attributes = attributes;
  }

  if (metricType === 'count') {
    Sentry.metrics.count(name, value, metricOptions);
    return;
  }

  if (metricType === 'gauge') {
    Sentry.metrics.gauge(name, value, metricOptions);
    return;
  }

  if (metricType === 'distribution') {
    Sentry.metrics.distribution(name, value, metricOptions);
  }
}

function recordCount(name, value = 1, attributes = {}) {
  recordMetric('count', name, value, { attributes });
}

function recordGauge(name, value, attributes = {}) {
  recordMetric('gauge', name, value, { attributes });
}

function recordDistribution(name, value, options = {}) {
  recordMetric('distribution', name, value, options);
}

function startSpan(options, callback) {
  if (typeof Sentry.startSpan !== 'function') {
    return callback();
  }

  return Sentry.startSpan(options, callback);
}

function closeSentry() {
  return Sentry.close(2000);
}

module.exports = {
  Sentry,
  captureError,
  closeSentry,
  recordCount,
  recordGauge,
  recordDistribution,
  startSpan
};