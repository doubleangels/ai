const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Helpers to stub modules before requiring aiService
function stubModule(resolvedName, exportsObj) {
  try {
    const resolved = require.resolve(resolvedName);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: exportsObj
    };
    return resolved;
  } catch (e) {
    // if resolution fails, skip stub (module may not be installed)
    return null;
  }
}

test('generateAIResponse uses OpenAI when configured', async () => {
  // Arrange: set env and stub OpenAI
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'fake';

  const fakeOpenAI = {
    OpenAI: class {
      constructor() { this.responses = { create: async () => ({ status: 'completed', output_text: 'hello from openai', id: 'r1', usage: { total_tokens: 10 } }) }; }
    }
  };
  stubModule('openai', fakeOpenAI);

  // Clear config and aiService from cache so they pick up env + stubs
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../utils/aiService')];

  const aiService = require('../utils/aiService');

  const reply = await aiService.generateAIResponse([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.equal(reply.includes('hello from openai'), true);
});

test('generateAIResponse uses Gemini when configured', async () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'fake';

  const fakeGen = {
    GoogleGenAI: class { constructor() { this.models = { generateContent: async () => ({ text: 'hello gemini' }) }; } }
  };
  stubModule('@google/genai', fakeGen);

  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../utils/aiService')];

  const aiService = require('../utils/aiService');
  const reply = await aiService.generateAIResponse([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.equal(typeof reply, 'string');
});

test('generateAIResponse uses Claude when configured', async () => {
  process.env.AI_PROVIDER = 'claude';
  process.env.ANTHROPIC_API_KEY = 'fake';

  const fakeAnthropic = function FakeAnthropic() {
    this.messages = { create: async () => ({ content: [{ type: 'text', text: 'hello claude' }] }) };
  };
  stubModule('@anthropic-ai/sdk', fakeAnthropic);

  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../utils/aiService')];

  const aiService = require('../utils/aiService');
  const reply = await aiService.generateAIResponse([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.equal(typeof reply, 'string');
});

// --- appended from test/aiService.coverage.test.js ---
const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');

function stubModuleCoverage(modulePath, exportsObj) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsObj
  };
}

function withEnvCoverage(overrides, run) {
  const keys = Object.keys(overrides);
  const saved = new Map(keys.map(key => [key, process.env[key]]));

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

function loadAiServiceCoverage(providerStubs = {}, env = {}) {
  delete require.cache[aiServicePath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];

  stubModuleCoverage(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    closeSentry: async () => {},
    recordCount: () => {},
    recordGauge: () => {},
    recordDistribution: () => {},
    startSpan: async (_options, callback) => callback()
  });

  if (providerStubs.openai) {
    stubModuleCoverage(require.resolve('openai'), providerStubs.openai);
  }
  if (providerStubs.genai) {
    stubModuleCoverage(require.resolve('@google/genai'), providerStubs.genai);
  }
  if (providerStubs.anthropic) {
    stubModuleCoverage(require.resolve('@anthropic-ai/sdk'), providerStubs.anthropic);
  }

  let loaded;
  return withEnvCoverage(env, () => {
    loaded = require(aiServicePath);
    return loaded;
  }).then(() => loaded);
}

test('OpenAI request includes reasoning, verbosity, tools, and image prompt handling (coverage merged)', async () => {
  let capturedRequest;
  const aiServiceCov = await loadAiServiceCoverage({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async request => {
              capturedRequest = request;
              return {
                status: 'completed',
                output_text: 'openai result',
                id: 'openai-1',
                usage: { total_tokens: 10 }
              };
            }
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    REASONING_EFFORT: 'high',
    RESPONSES_VERBOSITY: 'medium',
    ENABLE_WEB_SEARCH: '1'
  });

  const reply = await aiServiceCov.generateAIResponse([
    { role: 'system', content: 'system prompt' },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'hello' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
      ]
    }
  ]);

  assert.equal(reply, 'openai result');
  assert.equal(capturedRequest.model, 'gpt-5.4-nano');
  assert.equal(capturedRequest.reasoning.effort, 'high');
  assert.equal(capturedRequest.text.verbosity, 'medium');
  assert.equal(Array.isArray(capturedRequest.tools), true);
  assert.equal(capturedRequest.tools[0].type, 'web_search');
  assert.match(capturedRequest.input[0].content, /When analyzing images/);
});
