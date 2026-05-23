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

function loadAiService({ openai, genai, anthropic, instrument: instrumentOverrides = {} } = {}, env = {}) {
  delete require.cache[aiServicePath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];

  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false, ...instrumentOverrides.Sentry },
    captureError: instrumentOverrides.captureError || (() => {}),
    closeSentry: async () => {},
    recordCount: instrumentOverrides.recordCount || (() => {}),
    recordGauge: () => {},
    recordDistribution: instrumentOverrides.recordDistribution || (() => {}),
    startSpan: instrumentOverrides.startSpan || (async (_opts, cb) => cb())
  });

  if (openai) stubModule(require.resolve('openai'), openai);
  if (genai) stubModule(require.resolve('@google/genai'), genai);
  if (anthropic) stubModule(require.resolve('@anthropic-ai/sdk'), anthropic);

  return withEnv(env, () => require(aiServicePath));
}

test('generateAIResponse uses OpenAI when configured', async () => {
  const aiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async () => ({
              status: 'completed',
              output_text: 'hello from openai',
              id: 'r1',
              usage: { total_tokens: 10 }
            })
          };
        }
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' }
  ]);
  assert.match(reply, /hello from openai/);
});

test('generateAIResponse uses Gemini when configured', async () => {
  const aiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'hello gemini' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' }
  ]);
  assert.equal(reply, 'hello gemini');
});

test('generateAIResponse uses Claude when configured', async () => {
  const aiService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => ({ content: [{ type: 'text', text: 'hello claude' }] })
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' }
  ]);
  assert.equal(reply, 'hello claude');
});

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
  assert.equal(capturedRequest.tools[0].type, 'web_search');
  assert.match(capturedRequest.input[0].content, /When analyzing images/);
});

test('OpenAI API failure results in empty reply', async () => {
  const aiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async () => {
              throw Object.assign(new Error('service down'), { status: 500 });
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'ping' }
  ]);
  assert.equal(reply, '');
});

test('Gemini retries without cache when cached content causes 404', async () => {
  let callCount = 0;
  const aiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: async () => {
              callCount += 1;
              if (callCount === 1) {
                const err = new Error('cachedcontent not found');
                err.status = 404;
                throw err;
              }
              return { text: 'gemini after retry' };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' }
  ]);
  assert.equal(typeof reply, 'string');
});

test('generateAIResponse rejects empty conversation', async () => {
  const aiService = await loadAiService({
    openai: { OpenAI: class { constructor() { this.responses = { create: async () => ({}) }; } } }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });

  const reply = await aiService.generateAIResponse([]);
  assert.equal(reply, '');
});

test('generateAIResponse rethrows when provider span callback fails', async () => {
  const aiService = await loadAiService({
    openai: { OpenAI: class { constructor() { this.responses = { create: async () => ({}) }; } } },
    instrument: {
      startSpan: async () => {
        throw new Error('span failed');
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });

  await assert.rejects(
    async () => aiService.generateAIResponse([{ role: 'user', content: 'hi' }]),
    /span failed/
  );
});

test('OpenAI returns empty when API key missing', async () => {
  const aiService = await loadAiService({}, { AI_PROVIDER: 'openai', OPENAI_API_KEY: undefined });
  const reply = await aiService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  assert.equal(reply, '');
});

test('OpenAI handles API errors and incomplete responses', async () => {
  let call = 0;
  const aiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async () => {
              call += 1;
              if (call === 1) throw new Error('api down');
              return { status: 'incomplete', output_text: '', id: 'r1' };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });

  assert.equal(await aiService.generateAIResponse([{ role: 'user', content: 'hi' }]), '');

  call = 0;
  const aiService2 = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async () => {
              call += 1;
              if (call === 1) return { status: 'incomplete', output_text: 'partial', id: 'r2' };
              return { status: 'completed', output_text: '   ', id: 'r3', usage: { total_tokens: 1 } };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });

  assert.equal(await aiService2.generateAIResponse([{ role: 'user', content: 'hi' }]), 'partial');
  assert.match(
    await aiService2.generateAIResponse([{ role: 'user', content: 'hi again' }]),
    /couldn't generate a response/
  );
});

test('OpenAI outer catch returns empty string', async () => {
  const aiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async () => {
              throw Object.assign(new Error('fatal'), { type: 'server', code: '500', status: 500 });
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });

  const brokenConversation = [{ role: 'user', content: 'hi' }];
  Object.defineProperty(brokenConversation, 'findIndex', {
    value: () => { throw new Error('boom'); }
  });

  const reply = await aiService.generateAIResponse(brokenConversation);
  assert.equal(reply, '');
});

test('Gemini returns empty without API key or valid turns', async () => {
  const noKey = await loadAiService({}, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: undefined });
  assert.equal(await noKey.generateAIResponse([{ role: 'user', content: 'hi' }]), '');

  const emptyTurns = await loadAiService({
    genai: { GoogleGenAI: class { constructor() { this.models = { generateContent: async () => ({ text: 'x' }) }; } } }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  assert.equal(await emptyTurns.generateAIResponse([{ role: 'system', content: 'only system' }]), '');
});

test('Gemini uses cache, tools, safety settings, and handles failures', async () => {
  let cacheCreates = 0;
  const aiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = {
            create: async () => {
              cacheCreates += 1;
              if (cacheCreates === 1) return { name: 'cache-1' };
              throw new Error('cache create failed');
            }
          };
          this.models = {
            generateContent: async ({ config }) => {
              if (config.cachedContent) {
                const err = new Error('cachedcontent not found');
                err.status = 404;
                throw err;
              }
              return { text: () => 'gemini ok' };
            }
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'fake',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    ENABLE_CONTEXT_CACHE: '1',
    ENABLE_WEB_SEARCH: '1',
    ENABLE_GOOGLE_MAPS: '1',
    GEMINI_SAFETY_SETTINGS: '[{"category":"HARM_CATEGORY_HARASSMENT","threshold":"BLOCK_MEDIUM_AND_ABOVE"}]'
  });

  const longSystem = 'x'.repeat(3000);
  const reply = await aiService.generateAIResponse([
    { role: 'system', content: longSystem },
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }, { type: 'input_image', image_url: 'data:image/png;base64,QUFB' }] }
  ]);
  assert.equal(reply, 'gemini ok');

  const emptyReply = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: '   ' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  assert.match(await emptyReply.generateAIResponse([{ role: 'user', content: 'hi' }]), /couldn't generate a response/);

  const retryFail = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => ({ name: 'cache-2' }) };
          this.models = {
            generateContent: async () => {
              const err = new Error('cachedcontent expired');
              err.status = 404;
              throw err;
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', ENABLE_CONTEXT_CACHE: '1' });
  assert.equal(
    await retryFail.generateAIResponse([{ role: 'system', content: 'x'.repeat(3000) }, { role: 'user', content: 'hi' }]),
    ''
  );
});

test('OpenAI prepends image analysis system prompt when missing', async () => {
  const aiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async request => {
              assert.equal(request.input[0].role, 'system');
              assert.match(request.input[0].content, /When analyzing images/);
              return { status: 'completed', output_text: 'ok', id: 'r1', usage: { total_tokens: 1 } };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });

  const reply = await aiService.generateAIResponse([
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }]
    }
  ]);
  assert.equal(reply, 'ok');
});

test('generateAIResponse records errors when post-processing metrics fail', async () => {
  const aiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async () => ({
              status: 'completed',
              output_text: 'ok',
              id: 'r1',
              usage: { total_tokens: 1 }
            })
          };
        }
      }
    },
    instrument: {
      recordCount: name => {
        if (name === 'ai.generate.requests') throw new Error('metric failed');
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });

  await assert.rejects(
    async () => aiService.generateAIResponse([{ role: 'user', content: 'hi' }]),
    /metric failed/
  );
});

test('Gemini reuses valid cache entries without recreating', async () => {
  let createCalls = 0;
  const aiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = {
            create: async () => {
              createCalls += 1;
              return { name: `cache-${createCalls}` };
            }
          };
          this.models = {
            generateContent: async () => ({ text: 'cached ok' })
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'fake',
    ENABLE_CONTEXT_CACHE: '1'
  });

  const conversation = [
    { role: 'system', content: 'x'.repeat(9000) },
    { role: 'user', content: 'hello' }
  ];
  await aiService.generateAIResponse(conversation);
  await aiService.generateAIResponse(conversation);
  assert.equal(createCalls, 1);
});

test('Claude uses plain system prompt when context cache is disabled', async () => {
  let capturedSystem;
  const aiService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async params => {
          capturedSystem = params.system;
          return { content: [{ type: 'text', text: 'ok' }] };
        }
      };
    }
  }, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'fake',
    ENABLE_CONTEXT_CACHE: '0'
  });

  await aiService.generateAIResponse([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.equal(capturedSystem, 'sys');
});

test('Claude uses image analysis prompt without a system message', async () => {
  let capturedSystem;
  const aiService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async params => {
          capturedSystem = params.system;
          return { content: [{ type: 'text', text: 'ok' }] };
        }
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });

  await aiService.generateAIResponse([
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }] }
  ]);
  assert.match(capturedSystem, /When analyzing images/);
});

test('Claude handles tools, thinking, empty responses, and API failures', async () => {
  let round = 0;
  const aiService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => {
          round += 1;
          if (round === 1) {
            return {
              content: [
                { type: 'tool_use', id: 'tool-1', name: 'get_current_time', input: {} },
                { type: 'tool_use', id: 'tool-2', name: 'unknown_tool', input: {} }
              ]
            };
          }
          return { content: [{ type: 'text', text: 'done' }] };
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
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'input_text', text: 'time?' }, { type: 'input_image', image_url: 'data:image/png;base64,QUFB' }] }
  ]);
  assert.equal(reply, 'done');

  const noKey = await loadAiService({}, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: undefined });
  assert.equal(await noKey.generateAIResponse([{ role: 'user', content: 'hi' }]), '');

  const emptyText = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = { create: async () => ({ content: [{ type: 'text', text: '  ' }] }) };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  assert.match(await emptyText.generateAIResponse([{ role: 'user', content: 'hi' }]), /couldn't generate a response/);

  let toolRounds = 0;
  const maxRounds = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => {
          toolRounds += 1;
          return { content: [{ type: 'tool_use', id: `t-${toolRounds}`, name: 'unknown_tool', input: {} }] };
        }
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  assert.match(await maxRounds.generateAIResponse([{ role: 'user', content: 'hi' }]), /couldn't complete/);

  const apiFail = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = { create: async () => { throw new Error('claude down'); } };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  assert.equal(await apiFail.generateAIResponse([{ role: 'user', content: 'hi' }]), '');
});

test('Gemini handles non-stale API failures, empty retries, and text property responses', async () => {
  const notStale = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => ({ name: 'cache-1' }) };
          this.models = {
            generateContent: async () => {
              throw new Error('generic gemini failure');
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', ENABLE_CONTEXT_CACHE: '1' });
  assert.equal(
    await notStale.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }]),
    ''
  );

  const emptyRetry = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => ({ name: 'cache-2' }) };
          this.models = {
            generateContent: async ({ config }) => {
              if (config.cachedContent) {
                const err = new Error('cachedcontent not found');
                err.status = 404;
                throw err;
              }
              return { text: '   ' };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', ENABLE_CONTEXT_CACHE: '1' });
  assert.equal(
    await emptyRetry.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }]),
    ''
  );

  const textProperty = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'plain text property' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  assert.equal(await textProperty.generateAIResponse([{ role: 'user', content: 'hi' }]), 'plain text property');
});

test('Claude skips blank assistant turns and handles tool input defaults', async () => {
  const claudeService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => ({ content: [{ type: 'text', text: 'ok' }] })
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });

  assert.equal(
    await claudeService.generateAIResponse([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'again' }
    ]),
    'ok'
  );

  let round = 0;
  const toolService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => {
          round += 1;
          if (round === 1) {
            return { content: [{ type: 'tool_use', id: 'tool-1', name: 'get_current_time' }] };
          }
          return { content: [{ type: 'text', text: 'time sent' }] };
        }
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  assert.equal(await toolService.generateAIResponse([{ role: 'user', content: 'time?' }]), 'time sent');
});

test('Gemini formatters handle invalid data URLs and non-string system content', async () => {
  const geminiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'parsed ok' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });

  assert.equal(
    await geminiService.generateAIResponse([
      { role: 'system', content: [{ type: 'text', text: 'ignored' }] },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'hello' },
          { type: 'input_image', image_url: 'not-a-data-url' },
          { type: 'input_image', image_url: '' },
          { type: 'input_image', image_url: null }
        ]
      }
    ]),
    'parsed ok'
  );
});

test('Gemini reads plain text property when response.text is not a function', async () => {
  const geminiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'plain property' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });

  assert.equal(await geminiService.generateAIResponse([{ role: 'user', content: 'hi' }]), 'plain property');
});

test('Gemini handles missing response text and invalid image data URLs', async () => {
  const missingText = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({}) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  assert.match(await missingText.generateAIResponse([{ role: 'user', content: 'hi' }]), /couldn't generate a response/);

  const invalidImageUrl = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'ok' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  assert.equal(
    await invalidImageUrl.generateAIResponse([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'hello' },
          { type: 'input_image', image_url: 123 }
        ]
      }
    ]),
    'ok'
  );
});

test('Gemini retry path handles text() function responses after stale cache', async () => {
  const retryTextFn = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => ({ name: 'cache-retry-fn' }) };
          this.models = {
            generateContent: async ({ config }) => {
              if (config.cachedContent) {
                const err = new Error('cachedcontent not found');
                err.status = 404;
                throw err;
              }
              return { text: () => 'retry function text' };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', ENABLE_CONTEXT_CACHE: '1' });
  assert.equal(
    await retryTextFn.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }]),
    'retry function text'
  );

  const retryPlainProperty = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => ({ name: 'cache-retry-prop' }) };
          this.models = {
            generateContent: async ({ config }) => {
              if (config.cachedContent) {
                const err = new Error('cachedcontent not found');
                err.status = 404;
                throw err;
              }
              return { text: 'retry plain property' };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', ENABLE_CONTEXT_CACHE: '1' });
  assert.equal(
    await retryPlainProperty.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }]),
    'retry plain property'
  );

  const retryMissingText = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => ({ name: 'cache-retry-empty' }) };
          this.models = {
            generateContent: async ({ config }) => {
              if (config.cachedContent) {
                const err = new Error('cachedcontent not found');
                err.status = 404;
                throw err;
              }
              return undefined;
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', ENABLE_CONTEXT_CACHE: '1' });
  assert.equal(
    await retryMissingText.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }]),
    ''
  );
});

test('provider formatters handle non-string message content branches', async () => {
  const geminiNonStringAssistant = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'ok' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  assert.equal(
    await geminiNonStringAssistant.generateAIResponse([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] }
    ]),
    'ok'
  );

  const claudeNonString = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = { create: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  assert.equal(
    await claudeNonString.generateAIResponse([
      { role: 'system', content: [{ type: 'text', text: 'ignored' }] },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] }
    ]),
    'ok'
  );
});

test('Gemini handles non-string API errors and retry text() responses', async () => {
  const nonStringError = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => ({ name: 'cache-1' }) };
          this.models = {
            generateContent: async () => {
              throw { status: 404, code: 404 };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', ENABLE_CONTEXT_CACHE: '1' });
  assert.equal(
    await nonStringError.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }]),
    ''
  );

  const retryTextFn = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => ({ name: 'cache-2' }) };
          this.models = {
            generateContent: async ({ config }) => {
              if (config.cachedContent) {
                const err = new Error('cachedcontent not found');
                err.status = 404;
                throw err;
              }
              return { text: () => 'retry via function' };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', ENABLE_CONTEXT_CACHE: '1' });
  assert.equal(
    await retryTextFn.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }]),
    'retry via function'
  );
});

test('Claude handles missing response content in tool rounds', async () => {
  const claudeService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => ({ content: null })
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });

  assert.match(await claudeService.generateAIResponse([{ role: 'user', content: 'hi' }]), /couldn't generate a response/);
});

test('OpenAI outer catch tags unknown provider when config provider is empty', async () => {
  let capturedProvider;
  delete require.cache[aiServicePath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];

  stubModule(configPath, {
    openaiApiKey: 'fake',
    geminiApiKey: 'fake',
    anthropicApiKey: 'fake',
    modelName: 'gpt-5.4-nano',
    getTemperature: () => 1,
    reasoningEffort: 'none',
    responsesVerbosity: 'low',
    aiProvider: '',
    enableWebSearch: false,
    enableGoogleMaps: false,
    enableContextCache: false,
    geminiCacheTtlSeconds: 3600,
    maxOutputTokens: 1024,
    claudeThinkingBudgetTokens: 0,
    openaiTimeoutMs: 60000,
    openaiMaxRetries: 2
  });
  stubModule(require.resolve('openai'), {
    OpenAI: class {
      constructor() {
        this.responses = { create: async () => ({ status: 'completed', output_text: 'ok', id: 'r1' }) };
      }
    }
  });
  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: (_err, ctx) => { capturedProvider = ctx.provider; },
    recordCount: () => {},
    recordGauge: () => {},
    recordDistribution: () => {},
    startSpan: async (_opts, cb) => cb()
  });

  const aiService = require(aiServicePath);
  const broken = [{ role: 'user', content: 'hi' }];
  Object.defineProperty(broken, Symbol.iterator, {
    value() {
      throw new Error('iter failed');
    }
  });

  const reply = await aiService.generateAIResponse(broken);
  assert.equal(reply, '');
  assert.equal(capturedProvider, 'unknown');
});

test('generateAIResponse captureError tags unknown provider on post-success failures', async () => {
  delete require.cache[aiServicePath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];

  stubModule(configPath, {
    openaiApiKey: 'fake',
    geminiApiKey: 'fake',
    anthropicApiKey: 'fake',
    modelName: 'gpt-5.4-nano',
    getTemperature: () => 1,
    reasoningEffort: 'none',
    responsesVerbosity: 'low',
    aiProvider: '',
    enableWebSearch: false,
    enableGoogleMaps: false,
    enableContextCache: false,
    geminiCacheTtlSeconds: 3600,
    maxOutputTokens: 1024,
    claudeThinkingBudgetTokens: 0,
    openaiTimeoutMs: 60000,
    openaiMaxRetries: 2
  });
  stubModule(require.resolve('openai'), {
    OpenAI: class {
      constructor() {
        this.responses = {
          create: async () => ({
            status: 'completed',
            output_text: 'ok',
            id: 'r1',
            usage: { total_tokens: 1 }
          })
        };
      }
    }
  });
  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    recordCount: name => {
      if (name === 'ai.generate.requests') throw new Error('metric failed');
    },
    recordGauge: () => {},
    recordDistribution: () => {},
    startSpan: async (_opts, cb) => cb()
  });

  const aiService = require(aiServicePath);
  await assert.rejects(
    async () => aiService.generateAIResponse([{ role: 'user', content: 'hi' }]),
    /metric failed/
  );
});
