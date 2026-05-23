const defaultStub = {
  Sentry: {
    isEnabled: () => false,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    metrics: { count: () => {}, gauge: () => {}, distribution: () => {} },
    startSpan: (_opts, cb) => cb(),
    close: async () => {}
  },
  captureError: err => err,
  closeSentry: async () => {},
  recordCount: () => {},
  recordGauge: () => {},
  recordDistribution: () => {},
  startSpan: (_opts, cb) => cb()
};

module.exports = global.__instrumentStub || defaultStub;
