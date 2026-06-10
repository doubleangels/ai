const pino = require('pino');

const { Sentry } = require('./instrument');
const config = require('./config');

// Create base logger with configuration
const PII_META_KEYS = new Set(['user', 'guildList', 'channelName']);

function sanitizeMetaForSentry(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const sanitized = { ...meta };
  for (const key of PII_META_KEYS) {
    if (key in sanitized) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

const baseLogger = pino({
  level: config.logLevel || 'info',
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
    // Create a child logger with the label as context
    const childLogger = baseLogger.child({ label });

    function sendToSentry(level, message, meta) {
      const sentryLogger = Sentry && Sentry.logger;
      if (!sentryLogger || typeof sentryLogger[level] !== 'function') {
        return;
      }

      try {
        if (meta && typeof meta === 'object') {
          sentryLogger[level](message, sanitizeMetaForSentry(meta));
        } else {
          sentryLogger[level](message);
        }
      } catch (error) {
        childLogger.debug({ error: error.message }, 'Failed to forward log to Sentry.');
      }
    }

    function write(level, message, meta) {
      // Ensure message is a full sentence with ending punctuation when it's a string.
      if (typeof message === 'string' && message.trim().length > 0) {
        const trimmed = message.trim();
        const last = trimmed[trimmed.length - 1];
        if (!['.', '!', '?'].includes(last)) {
          message = `${trimmed}.`;
        } else {
          message = trimmed;
        }
      }

      if (meta && typeof meta === 'object') {
        childLogger[level](meta, message);
      } else {
        childLogger[level](message);
      }

      sendToSentry(level, message, meta);
    }

    // Wrap the logger methods to maintain compatibility with winston-style usage
    // where metadata objects are passed as second parameter
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
      // Expose the raw pino logger for advanced usage if needed
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

getLogger.sanitizeMetaForSentry = sanitizeMetaForSentry;
module.exports = getLogger;