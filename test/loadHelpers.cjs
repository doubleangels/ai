const path = require('path');
const { stubModule, clearStubModuleCaches, reloadModule } = require('./testUtils.cjs');

const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
const aiUtilsPath = path.resolve(__dirname, '..', 'utils', 'aiUtils.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');

function withEnv(overrides, run) {
  const keys = Object.keys(overrides);
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function setSdkStubs({ openai, genai, anthropic } = {}) {
  if (openai) global.__openaiStub = openai;
  if (genai) global.__googleGenaiStub = genai;
  if (anthropic) global.__anthropicStub = anthropic;
  clearStubModuleCaches();
}

function loadAiService({ openai, genai, anthropic, instrument: instrumentOverrides = {} } = {}, env = {}) {
  return withEnv(env, () => {
    setSdkStubs({ openai, genai, anthropic });
    jest.unmock(configPath);
    jest.unmock(instrumentPath);
    jest.unmock(aiServicePath);
    jest.unmock(aiUtilsPath);

    return reloadModule(aiServicePath, () => {
      stubModule(instrumentPath, {
        Sentry: { isEnabled: () => false, ...instrumentOverrides.Sentry },
        captureError: instrumentOverrides.captureError || (err => err),
        closeSentry: async () => {},
        recordCount: instrumentOverrides.recordCount || (() => {}),
        recordGauge: () => {},
        recordDistribution: instrumentOverrides.recordDistribution || (() => {}),
        startSpan: instrumentOverrides.startSpan || (async (_opts, cb) => cb())
      });
    });
  });
}

module.exports = {
  withEnv,
  setSdkStubs,
  loadAiService,
  aiServicePath,
  configPath,
  instrumentPath
};
