const defaultFactory = () => {
  const logger = {
    child: () => logger,
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    isLevelEnabled: () => true
  };
  return logger;
};
defaultFactory.stdTimeFunctions = { isoTime: () => `,"time":"${new Date().toISOString()}"` };

module.exports = global.__pinoStub || defaultFactory;
