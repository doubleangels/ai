const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');

function stubModule(modulePath, exportsObj) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsObj
  };
}

function withEnv(overrides, run) {
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

function loadAiService(providerStubs = {}, env = {}) {
  delete require.cache[aiServicePath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];

  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    closeSentry: async () => {},
    recordCount: () => {},
    recordGauge: () => {},
    recordDistribution: () => {},
    startSpan: async (_options, callback) => callback()
  });

  if (providerStubs.openai) {
    stubModule(require.resolve('openai'), providerStubs.openai);
  }
  if (providerStubs.genai) {
    stubModule(require.resolve('@google/genai'), providerStubs.genai);
  }
  if (providerStubs.anthropic) {
    stubModule(require.resolve('@anthropic-ai/sdk'), providerStubs.anthropic);
  }

  let loaded;
  return withEnv(env, () => {
    loaded = require(aiServicePath);
    return loaded;
  }).then(() => loaded);
}

test('OpenAI request includes reasoning, verbosity, tools, and image prompt handling', async () => {
  let capturedRequest;
  const aiService = await loadAiService({
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

  const reply = await aiService.generateAIResponse([
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

test('OpenAI prepends image-analysis system text when no system message exists', async () => {
  let capturedRequest;
  const aiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async request => {
              capturedRequest = request;
              return {
                status: 'completed',
                output_text: 'openai result',
                id: 'openai-images',
                usage: { total_tokens: 1 }
              };
            }
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano'
  });

  const reply = await aiService.generateAIResponse([
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }
  ]);

  assert.equal(reply, 'openai result');
  assert.equal(capturedRequest.input[0].role, 'system');
});

test('OpenAI incomplete responses return partial text or empty string', async () => {
  let callCount = 0;
  const aiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async () => {
              callCount += 1;
              if (callCount === 1) {
                return { status: 'incomplete', output_text: 'partial', id: 'openai-2' };
              }
              return { status: 'incomplete', output_text: '', id: 'openai-3' };
            }
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano'
  });

  const partial = await aiService.generateAIResponse([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' }
  ]);
  const empty = await aiService.generateAIResponse([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' }
  ]);

  assert.equal(partial, 'partial');
  assert.equal(empty, '');
});

test('OpenAI returns an empty string when not configured', async () => {
  const aiService = await loadAiService({}, {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL_NAME: 'gpt-5.4-nano'
  });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' }
  ]);

  assert.equal(reply, '');
});

test('Gemini retries with a fresh request when cache is stale', async () => {
  let callCount = 0;
  const aiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = {
            create: async () => ({ name: 'cache-1' })
          };
          this.models = {
            generateContent: async () => {
              callCount += 1;
              if (callCount === 1) {
                const error = new Error('cachedcontent not found');
                error.status = 404;
                throw error;
              }
              return { text: 'gemini retry result' };
            }
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    ENABLE_CONTEXT_CACHE: '1'
  });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'x'.repeat(9000) },
    { role: 'user', content: 'hello' }
  ]);

  assert.equal(reply, 'gemini retry result');
  assert.equal(callCount, 2);
});

test('Gemini falls back when cache creation fails and handles empty responses', async () => {
  const aiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = {
            create: async () => {
              throw new Error('cache failed');
            }
          };
          this.models = {
            generateContent: async () => ({ text: '' })
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    ENABLE_CONTEXT_CACHE: '1'
  });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'x'.repeat(9000) },
    { role: 'user', content: 'hello' }
  ]);

  assert.equal(reply.includes('couldn\'t generate a response'), true);
});

test('Gemini uses a cached context when available', async () => {
  let cacheCreateCount = 0;
  let generationCount = 0;
  const aiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = {
            create: async () => {
              cacheCreateCount += 1;
              return { name: 'cache-1' };
            }
          };
          this.models = {
            generateContent: async request => {
              generationCount += 1;
              if (generationCount === 1) {
                assert.equal(request.config.cachedContent, 'cache-1');
              }
              return { text: 'gemini cached result' };
            }
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    ENABLE_CONTEXT_CACHE: '1'
  });

  const conversation = [
    { role: 'system', content: 'x'.repeat(9000) },
    { role: 'user', content: 'hello' }
  ];

  const first = await aiService.generateAIResponse(conversation);
  const second = await aiService.generateAIResponse(conversation);

  assert.equal(first, 'gemini cached result');
  assert.equal(second, 'gemini cached result');
  assert.equal(cacheCreateCount, 1);
});

test('Gemini returns empty string when not configured', async () => {
  const aiService = await loadAiService({}, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: undefined,
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview'
  });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' }
  ]);

  assert.equal(reply, '');
});

test('Gemini returns empty string when no valid turns exist', async () => {
  const aiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: async () => ({ text: 'unused' })
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview'
  });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'system only' }
  ]);

  assert.equal(reply, '');
});

test('Claude handles tool calls and extended thinking', async () => {
  let callCount = 0;
  const aiService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async ({ messages }) => {
          callCount += 1;
          if (callCount === 1) {
            return {
              content: [{ type: 'tool_use', id: 'tool-1', name: 'get_current_time', input: {} }]
            };
          }

          return {
            content: [{ type: 'text', text: `tool rounds: ${messages.length}` }]
          };
        }
      };
    }
  }, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'claude-sonnet-4-5',
    CLAUDE_THINKING_BUDGET_TOKENS: '1024',
    ENABLE_CONTEXT_CACHE: '1'
  });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'what time is it?' }
  ]);

  assert.match(reply, /tool rounds:/);
  assert.equal(callCount, 2);
});

test('Claude returns a fallback message after max tool rounds', async () => {
  const aiService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => ({
          content: [{ type: 'tool_use', id: 'tool-1', name: 'get_current_time', input: {} }]
        })
      };
    }
  }, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'claude-sonnet-4-5'
  });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'loop' }
  ]);

  assert.match(reply, /couldn\'t complete that request/);
});

test('Claude returns empty string when not configured', async () => {
  const aiService = await loadAiService({}, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: undefined,
    OPENAI_MODEL_NAME: 'claude-sonnet-4-5'
  });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' }
  ]);

  assert.equal(reply, '');
});

test('Claude returns empty string when no valid turns exist', async () => {
  const aiService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => ({ content: [{ type: 'text', text: 'unused' }] })
      };
    }
  }, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'claude-sonnet-4-5'
  });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'system only' }
  ]);

  assert.equal(reply, '');
});

test('generateAIResponse returns empty string for empty conversations', async () => {
  const aiService = await loadAiService({}, {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano'
  });

  const reply = await aiService.generateAIResponse([]);
  assert.equal(reply, '');
});