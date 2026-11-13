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

    // Callers must only invoke this once they've confirmed Sentry.logger[level] exists.
    function sendToSentry(level, message, meta, sentryLogger) {
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
      const sentryLogger = Sentry && Sentry.logger;
      const canForwardToSentry = Boolean(sentryLogger && typeof sentryLogger[level] === 'function');
      const pinoEnabled = typeof childLogger.isLevelEnabled === 'function'
        ? childLogger.isLevelEnabled(level)
        : true;

      // Nothing will consume this line (pino level too low, Sentry logging off/unconfigured) —
      // skip building the message and deep-sanitizing meta instead of paying that cost and discarding it.
      if (!pinoEnabled && !canForwardToSentry) return;

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

      if (pinoEnabled) {
        if (sanitizedMeta && typeof sanitizedMeta === 'object') {
          childLogger[level](sanitizedMeta, message);
        } else {
          childLogger[level](message);
        }
      }

      if (canForwardToSentry) {
        sendToSentry(level, message, sanitizedMeta, sentryLogger);
      }
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
