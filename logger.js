const pino = require('pino');

const config = require('./config');

// Create base logger with configuration
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

    // Wrap the logger methods to maintain compatibility with winston-style usage
    // where metadata objects are passed as second parameter
    return {
      info: (message, meta) => {
        if (meta && typeof meta === 'object') {
          childLogger.info(meta, message);
        } else {
          childLogger.info(message);
        }
      },
      error: (message, meta) => {
        if (meta && typeof meta === 'object') {
          childLogger.error(meta, message);
        } else {
          childLogger.error(message);
        }
      },
      warn: (message, meta) => {
        if (meta && typeof meta === 'object') {
          childLogger.warn(meta, message);
        } else {
          childLogger.warn(message);
        }
      },
      debug: (message, meta) => {
        if (meta && typeof meta === 'object') {
          childLogger.debug(meta, message);
        } else {
          childLogger.debug(message);
        }
      },
      // Expose the raw pino logger for advanced usage if needed
      _pino: childLogger
    };
  } catch (error) {
    console.error('Failed to create logger:', error);
    throw new Error('Failed to create logger instance.');
  }
}

module.exports = getLogger;