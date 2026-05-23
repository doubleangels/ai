const Module = require('module');
const { registerCoreStubs, registerSentryStubs } = require('./jest.setup.cjs');

const originalModuleLoad = Module._load;
global.__originalFsReaddirSync = require('fs').readdirSync;

process.setMaxListeners(0);

beforeEach(() => {
  jest.resetModules();
  Module._load = originalModuleLoad;
  registerCoreStubs();
  registerSentryStubs();
  const { clearStubRegistry } = require('./testUtils.cjs');
  clearStubRegistry();
  delete global.__openaiStub;
  delete global.__googleGenaiStub;
  delete global.__anthropicStub;
  delete global.__discordStub;
  delete global.__pinoStub;
});

afterEach(() => {
  Module._load = originalModuleLoad;
  const fs = require('fs');
  if (global.__originalFsReaddirSync) {
    fs.readdirSync = global.__originalFsReaddirSync;
  }
});
