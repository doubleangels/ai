const pino = require('pino');

const { Sentry } = require('./instrument');
const config = require('./config');
const { sanitizeLogMeta } = require('./utils/logSanitize');

const baseLogger = pino({
  level: config.logLevel || 'info',
  redact: {
    paths: [
      'token',
      'apiKey',
      '*.apiKey',
      'openaiApiKey',
      'geminiApiKey',
      'anthropicApiKey',
      'discordBotToken',
      'headers.authorization',
      'authorization',
      'password',
      'secret'
    ],
    censor: '[REDACTED]'
  },
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    }
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

/**
 * Creates a Pino logger instance with the specified label
 * @param {string} label - The label to identify the logger instance
 * @returns {pino.Logger} Configured Pino logger instance with label context
 * @throws {Error} If label is invalid or logger creation fails
 */
function getLogger(label) {
  if (!label || typeof label !== 'string') {
    throw new Error('Invalid logger label provided.');
  }

  try {
    const childLogger = baseLogger.child({ label });

    function sendToSentry(level, message, meta) {
      const sentryLogger = Sentry && Sentry.logger;
      if (!sentryLogger || typeof sentryLogger[level] !== 'function') {
        return;
      }

      try {
        if (meta && typeof meta === 'object') {
          sentryLogger[level](message, meta);
        } else {
          sentryLogger[level](message);
        }
      } catch (error) {
        childLogger.debug({ error: error.message }, 'Failed to forward log to Sentry.');
      }
    }

    function write(level, message, meta) {
      if (typeof message === 'string' && message.trim().length > 0) {
        const trimmed = message.trim();
        const last = trimmed[trimmed.length - 1];
        if (!['.', '!', '?'].includes(last)) {
          message = `${trimmed}.`;
        } else {
          message = trimmed;
        }
      }

      const sanitizedMeta = meta && typeof meta === 'object' ? sanitizeLogMeta(meta) : meta;

      if (sanitizedMeta && typeof sanitizedMeta === 'object') {
        childLogger[level](sanitizedMeta, message);
      } else {
        childLogger[level](message);
      }

      sendToSentry(level, message, sanitizedMeta);
    }

    return {
      info: (message, meta) => {
        write('info', message, meta);
      },
      error: (message, meta) => {
        write('error', message, meta);
      },
      warn: (message, meta) => {
        write('warn', message, meta);
      },
      debug: (message, meta) => {
        write('debug', message, meta);
      },
      trace: (message, meta) => {
        write('trace', message, meta);
      },
      fatal: (message, meta) => {
        write('fatal', message, meta);
      },
      _pino: childLogger
    };
  } catch (error) {
    if (Sentry && typeof Sentry.captureException === 'function') {
      Sentry.captureException(error, { tags: { source: 'logger', handler: 'createLogger' } });
    }
    console.error('Failed to create logger.', error);
    throw new Error('Failed to create logger instance.');
  }
}

getLogger.sanitizeLogMeta = sanitizeLogMeta;
getLogger.sanitizeMetaForSentry = sanitizeLogMeta;
module.exports = getLogger;
