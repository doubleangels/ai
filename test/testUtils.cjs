const path = require('path');

const STUB_FILES = [
  path.join(__dirname, 'stubs', 'openai.cjs'),
  path.join(__dirname, 'stubs', 'googleGenai.cjs'),
  path.join(__dirname, 'stubs', 'anthropic.cjs'),
  path.join(__dirname, 'stubs', 'discord.cjs'),
  path.join(__dirname, 'stubs', 'pino.cjs')
];

const DEFAULT_CONFIG = {
  token: 'fake-token',
  clientId: 'client-1',
  allowedGuildIds: new Set(),
  logLevel: 'info',
  maxHistoryLength: 20,
  maxHistoryTokens: 0,
  modelName: 'gpt-5.4-nano',
  openaiApiKey: 'fake',
  geminiApiKey: 'fake',
  anthropicApiKey: 'fake',
  aiProvider: 'openai',
  reasoningEffort: 'none',
  responsesVerbosity: 'low',
  enableWebSearch: false,
  enableGoogleMaps: false,
  enableContextCache: false,
  geminiCacheTtlSeconds: 3600,
  geminiSafetySettings: undefined,
  maxOutputTokens: 1024,
  claudeThinkingBudgetTokens: 0,
  userCooldownMs: 0,
  channelCooldownMs: 0,
  maxPendingPerChannel: 3,
  maxReplyChainDepth: 15,
  messageCacheMaxSize: 500,
  messageCacheTtlMs: 1_800_000,
  imageDownloadTimeoutMs: 8000,
  maxImageBytes: 6_000_000,
  maxReplyChainImages: 4,
  openaiTimeoutMs: 60000,
  openaiMaxRetries: 2,
  conversationHistoryMaxChannels: 500,
  conversationHistoryIdleMs: 86_400_000,
  backupModels: [],
  secondaryModelName: null,
  secondaryProvider: null,
  tertiaryModelName: null,
  tertiaryProvider: null,
  discordShardCount: 0,
  getTemperature: () => 1
};

const stubRegistry = new Map();
const stubbedModuleIds = new Set();

function resolveModuleId(moduleId) {
  if (path.isAbsolute(moduleId)) return moduleId;
  if (moduleId.startsWith('.')) return require.resolve(moduleId);
  return require.resolve(moduleId);
}

function stubModule(moduleId, exportsObj) {
  const resolved = resolveModuleId(moduleId);
  stubRegistry.set(resolved, exportsObj);
  stubbedModuleIds.add(resolved);
  jest.doMock(resolved, () => stubRegistry.get(resolved), { virtual: true });
}

function clearStubRegistry() {
  stubRegistry.clear();
  for (const resolved of stubbedModuleIds) {
    jest.unmock(resolved);
  }
  stubbedModuleIds.clear();
}

function clearStubModuleCaches() {
  for (const file of STUB_FILES) {
    delete require.cache[file];
  }
}

function reloadModule(moduleId, beforeRequire) {
  clearStubModuleCaches();
  jest.unmock(resolveModuleId(moduleId));
  let loaded;
  jest.isolateModules(() => {
    if (beforeRequire) beforeRequire();
    loaded = require(moduleId);
  });
  return loaded;
}

function defaultInstrumentStub(overrides = {}) {
  const sentryOverrides = overrides.Sentry || {};
  return {
    Sentry: {
      isEnabled: () => false,
      setConversationId: overrides.setConversationId || sentryOverrides.setConversationId || (() => {}),
      ...sentryOverrides
    },
    captureError: overrides.captureError || (() => {}),
    closeSentry: async () => {},
    recordCount: overrides.recordCount || (() => {}),
    recordGauge: overrides.recordGauge || (() => {}),
    recordDistribution: overrides.recordDistribution || (() => {}),
    startSpan: overrides.startSpan || (async (_opts, cb) => cb())
  };
}

module.exports = {
  DEFAULT_CONFIG,
  stubModule,
  clearStubRegistry,
  clearStubModuleCaches,
  reloadModule,
  defaultInstrumentStub
};
