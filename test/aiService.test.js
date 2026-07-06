const path = require('path');
const { loadAiService } = require('./loadHelpers.cjs');
const { stubModule, reloadModule, clearStubModuleCaches } = require('./testUtils.cjs');

const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');

test('should uses OpenAI when configured', async () => {
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
  expect(reply).toMatch(/hello from openai/);
});

test('should uses Gemini when configured', async () => {
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
  expect(reply).toBe('hello gemini');
});

test('should uses Claude when configured', async () => {
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
  expect(reply).toBe('hello claude');
});

test('should openAI request includes reasoning, verbosity, tools, and image prompt handling', async () => {
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

  expect(reply).toBe('openai result');
  expect(capturedRequest.model).toBe('gpt-5.4-nano');
  expect(capturedRequest.reasoning.effort).toBe('high');
  expect(capturedRequest.text.verbosity).toBe('medium');
  expect(capturedRequest.tools[0].type).toBe('web_search');
  expect(capturedRequest.input[0].content).toMatch(/When analyzing images/);
});

test('should openAI API failure results in empty reply', async () => {
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
  expect(reply).toMatch(/^⚠️ /);
});

test('should gemini retries without cache when cached content causes 404', async () => {
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
  expect(typeof reply).toBe('string');
});

test('should rejects empty conversation', async () => {
  const aiService = await loadAiService({
    openai: { OpenAI: class { constructor() { this.responses = { create: async () => ({}) }; } } }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });

  const reply = await aiService.generateAIResponse([]);
  expect(reply).toMatch(/^⚠️ /);
});

test('should rethrows when provider span callback fails', async () => {
  const aiService = await loadAiService({
    openai: { OpenAI: class { constructor() { this.responses = { create: async () => ({}) }; } } },
    instrument: {
      startSpan: async () => {
        throw new Error('span failed');
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });

  await expect(aiService.generateAIResponse([{ role: 'user', content: 'hi' }])).rejects.toThrow(/span failed/);
});

test('should openAI returns empty when API key missing', async () => {
  const aiService = await loadAiService({}, { AI_PROVIDER: 'openai', OPENAI_API_KEY: undefined });
  const reply = await aiService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  expect(reply).toMatch(/^⚠️ /);
});

test('should record error_user_message outcome for user-facing AI errors', async () => {
  const outcomes = [];
  const aiService = await loadAiService({
    instrument: {
      recordCount: (_name, _value, attrs) => {
        if (attrs?.outcome) outcomes.push(attrs.outcome);
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: undefined });

  const reply = await aiService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  expect(reply).toMatch(/isn't configured/);
  expect(outcomes).toContain('error_user_message');
});

test('should openAI handles API errors and incomplete responses', async () => {
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

  expect(await aiService.generateAIResponse([{ role: 'user', content: 'hi' }])).toMatch(/^⚠️ /);

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

  expect(await aiService2.generateAIResponse([{ role: 'user', content: 'hi' }])).toBe('partial');
  expect(await aiService2.generateAIResponse([{ role: 'user', content: 'hi again' }])).toMatch(/empty response/);
});

test('should openAI outer catch returns empty string', async () => {
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
  expect(reply).toMatch(/^⚠️ /);
});

test('should gemini returns empty without API key or valid turns', async () => {
  const noKey = await loadAiService({}, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: undefined });
  expect(await noKey.generateAIResponse([{ role: 'user', content: 'hi' }])).toMatch(/isn't configured/);

  const emptyTurns = await loadAiService({
    genai: { GoogleGenAI: class { constructor() { this.models = { generateContent: async () => ({ text: 'x' }) }; } } }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  expect(await emptyTurns.generateAIResponse([{ role: 'system', content: 'only system' }])).toMatch(/^⚠️ /);
});

test('should gemini uses cache, tools, safety settings, and handles failures', async () => {
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
  expect(reply).toBe('gemini ok');

  const emptyReply = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: '   ' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  expect(await emptyReply.generateAIResponse([{ role: 'user', content: 'hi' }])).toMatch(/empty response/);

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
  expect(await retryFail.generateAIResponse([{ role: 'system', content: 'x'.repeat(3000) }, { role: 'user', content: 'hi' }])).toMatch(/^⚠️ /);
});

test('should openAI prepends image analysis system prompt when missing', async () => {
  const aiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async request => {
              expect(request.input[0].role).toBe('system');
              expect(request.input[0].content).toMatch(/When analyzing images/);
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
  expect(reply).toBe('ok');
});

test('should records errors when post-processing metrics fail', async () => {
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

  await expect(aiService.generateAIResponse([{ role: 'user', content: 'hi' }])).rejects.toThrow(/metric failed/);
});

test('should gemini reuses valid cache entries without recreating', async () => {
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
  expect(createCalls).toBe(1);
});

test('should claude uses plain system prompt when context cache is disabled', async () => {
  let capturedSystem;
  let capturedMessages;
  const aiService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async params => {
          capturedSystem = params.system;
          capturedMessages = params.messages;
          return { content: [{ type: 'text', text: 'ok' }] };
        }
      };
    }
  }, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'fake',
    ENABLE_CONTEXT_CACHE: '0'
  });

  await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' }
  ]);
  expect(capturedSystem).toBe('sys');
  expect(capturedMessages[1].content).toBe('reply');
});

test('should claude marks prior turns for prompt caching when enabled', async () => {
  let capturedSystem;
  let capturedMessages;
  const aiService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async params => {
          capturedSystem = params.system;
          capturedMessages = params.messages;
          return { content: [{ type: 'text', text: 'ok' }] };
        }
      };
    }
  }, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'fake',
    ENABLE_CONTEXT_CACHE: '1'
  });

  await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' }
  ]);
  expect(capturedSystem[0].cache_control).toEqual({ type: 'ephemeral' });
  expect(capturedMessages[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
  expect(capturedMessages[2].content).toBe('second');
});

test('should openai uses prompt cache settings when context cache is enabled', async () => {
  let capturedParams;
  const aiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async params => {
              capturedParams = params;
              return { id: 'resp-1', status: 'completed', output_text: 'ok' };
            }
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'fake',
    ENABLE_CONTEXT_CACHE: '1'
  });

  await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' }
  ]);

  expect(capturedParams.prompt_cache_key).toBe('ai-bot-system-v1');
  expect(capturedParams.prompt_cache_retention).toBe('24h');
  expect(capturedParams.input[2].content[0].cache_control).toEqual({ type: 'ephemeral' });
});

test('should claude uses image analysis prompt without a system message', async () => {
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
  expect(capturedSystem[0].text).toMatch(/When analyzing images/);
});

test('should claude handles tools, thinking, empty responses, and API failures', async () => {
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
  expect(reply).toBe('done');

  const noKey = await loadAiService({}, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: undefined });
  expect(await noKey.generateAIResponse([{ role: 'user', content: 'hi' }])).toMatch(/isn't configured/);

  const emptyText = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = { create: async () => ({ content: [{ type: 'text', text: '  ' }] }) };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  expect(await emptyText.generateAIResponse([{ role: 'user', content: 'hi' }])).toMatch(/empty response/);

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
  expect(await maxRounds.generateAIResponse([{ role: 'user', content: 'what time is it?' }])).toMatch(/^⚠️ /);

  let createCalls = 0;
  const noTools = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => {
          createCalls += 1;
          return { content: [{ type: 'text', text: 'hello back' }] };
        }
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  expect(await noTools.generateAIResponse([{ role: 'user', content: 'hello' }])).toBe('hello back');
  expect(createCalls).toBe(1);

  const oddContent = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = { create: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  expect(await oddContent.generateAIResponse([
    { role: 'assistant', content: 'ignored' },
    { role: 'user', content: { not: 'text' } }
  ])).toBe('ok');

  const apiFail = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = { create: async () => { throw new Error('claude down'); } };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  expect(await apiFail.generateAIResponse([{ role: 'user', content: 'hi' }])).toMatch(/^⚠️ /);
});

test('should gemini handles non-stale API failures, empty retries, and text property responses', async () => {
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
  expect(await notStale.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }])).toMatch(/^⚠️ /);

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
  expect(await emptyRetry.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }])).toMatch(/empty response/);

  const textProperty = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'plain text property' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  expect(await textProperty.generateAIResponse([{ role: 'user', content: 'hi' }])).toBe('plain text property');
});

test('should claude skips blank assistant turns and handles tool input defaults', async () => {
  const claudeService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => ({ content: [{ type: 'text', text: 'ok' }] })
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });

  expect(await claudeService.generateAIResponse([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'again' }
    ])).toBe('ok');

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
  expect(await toolService.generateAIResponse([{ role: 'user', content: 'time?' }])).toBe('time sent');
});

test('should gemini formatters handle invalid data URLs and non-string system content', async () => {
  const geminiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'parsed ok' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });

  expect(await geminiService.generateAIResponse([
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
    ])).toBe('parsed ok');
});

test('should gemini reads plain text property when response.text is not a function', async () => {
  const geminiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'plain property' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });

  expect(await geminiService.generateAIResponse([{ role: 'user', content: 'hi' }])).toBe('plain property');
});

test('should gemini handles missing response text and invalid image data URLs', async () => {
  const missingText = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({}) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  expect(await missingText.generateAIResponse([{ role: 'user', content: 'hi' }])).toMatch(/empty response/);

  const invalidImageUrl = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'ok' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  expect(await invalidImageUrl.generateAIResponse([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'hello' },
          { type: 'input_image', image_url: 123 }
        ]
      }
    ])).toBe('ok');
});

test('should gemini retry path handles text() function responses after stale cache', async () => {
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
  expect(await retryTextFn.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }])).toBe('retry function text');

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
  expect(await retryPlainProperty.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }])).toBe('retry plain property');

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
  expect(await retryMissingText.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }])).toMatch(/empty response/);
});

test('should provider formatters handle non-string message content branches', async () => {
  const geminiNonStringAssistant = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'ok' }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  expect(await geminiNonStringAssistant.generateAIResponse([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] }
    ])).toBe('ok');

  const claudeNonString = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = { create: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  expect(await claudeNonString.generateAIResponse([
      { role: 'system', content: [{ type: 'text', text: 'ignored' }] },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] }
    ])).toBe('ok');
});

test('should gemini handles non-string API errors and retry text() responses', async () => {
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
  expect(await nonStringError.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }])).toMatch(/^⚠️ /);

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
  expect(await retryTextFn.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }])).toBe('retry via function');
});

test('should claude handles missing response content in tool rounds', async () => {
  const claudeService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => ({ content: null })
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });

  expect(await claudeService.generateAIResponse([{ role: 'user', content: 'hi' }])).toMatch(/empty response/);
});

test('should openAI outer catch tags provider when conversation preparation fails', async () => {
  let capturedProvider;

  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      geminiApiKey: undefined,
      anthropicApiKey: undefined,
      modelName: 'gpt-5.4-nano',
      getTemperature: () => 1,
      reasoningEffort: 'none',
      responsesVerbosity: 'low',
      aiProvider: 'openai',
      enableWebSearch: false,
      enableGoogleMaps: false,
      enableContextCache: false,
      geminiCacheTtlSeconds: 3600,
      maxOutputTokens: 1024,
      claudeThinkingBudgetTokens: 0,
      openaiTimeoutMs: 60000,
      openaiMaxRetries: 2,
      geminiTimeoutMs: 60000,
      claudeTimeoutMs: 60000
    });
    global.__openaiStub = {
      OpenAI: class {
        constructor() {
          this.responses = { create: async () => ({ status: 'completed', output_text: 'ok', id: 'r1' }) };
        }
      }
    };
    clearStubModuleCaches();
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: (_err, ctx) => { capturedProvider = ctx.provider; },
      recordCount: () => {},
      recordGauge: () => {},
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb()
    });
  });

  const broken = [{ role: 'user', content: 'hi' }];
  broken.map = () => {
    throw new Error('iter failed');
  };

  await expect(aiService.generateAIResponse(broken)).rejects.toThrow(/iter failed/);
  expect(capturedProvider).toBe('openai');
});

test('should captureError tags provider on post-success failures', async () => {
  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      geminiApiKey: undefined,
      anthropicApiKey: undefined,
      modelName: 'gpt-5.4-nano',
      getTemperature: () => 1,
      reasoningEffort: 'none',
      responsesVerbosity: 'low',
      aiProvider: 'openai',
      enableWebSearch: false,
      enableGoogleMaps: false,
      enableContextCache: false,
      geminiCacheTtlSeconds: 3600,
      maxOutputTokens: 1024,
      claudeThinkingBudgetTokens: 0,
      openaiTimeoutMs: 60000,
      openaiMaxRetries: 2,
      geminiTimeoutMs: 60000,
      claudeTimeoutMs: 60000
    });
    global.__openaiStub = {
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
    };
    clearStubModuleCaches();
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
  });

  await expect(aiService.generateAIResponse([{ role: 'user', content: 'hi' }])).rejects.toThrow(/metric failed/);
});

test('should openAI outer catch handles unexpected generation errors', async () => {
  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      geminiApiKey: undefined,
      anthropicApiKey: undefined,
      modelName: 'gpt-5.4-nano',
      getTemperature: () => {
        throw { message: 'bare failure' };
      },
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
      openaiMaxRetries: 2,
      geminiTimeoutMs: 60000,
      claudeTimeoutMs: 60000
    });
    global.__openaiStub = {
      OpenAI: class {
        constructor() {
          this.responses = { create: async () => ({ status: 'completed', output_text: 'ok', id: 'r1' }) };
        }
      }
    };
    clearStubModuleCaches();
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: () => {},
      recordGauge: () => {},
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb()
    });
  });

  const reply = await aiService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  expect(reply).toMatch(/^⚠️/);
});

test('should generateAIResponse catch uses unknown provider when config is empty', async () => {
  const captured = [];
  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      geminiApiKey: undefined,
      anthropicApiKey: undefined,
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
      openaiMaxRetries: 2,
      geminiTimeoutMs: 60000,
      claudeTimeoutMs: 60000
    });
    global.__openaiStub = {
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
    };
    clearStubModuleCaches();
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: (_err, ctx) => captured.push(ctx),
      recordCount: name => {
        if (name === 'ai.generate.requests') throw new Error('metric failed');
      },
      recordGauge: () => {},
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb()
    });
  });

  await expect(aiService.generateAIResponse([{ role: 'user', content: 'hi' }])).rejects.toThrow(/metric failed/);
  expect(captured[0].provider).toBe('unknown');
  expect(captured[0].handler).toBe('generateAIResponse');
});

test('should ProviderBusyError stores busy metadata', () => {
  const { ProviderBusyError } = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      modelName: 'gpt-5.4-nano',
      backupModels: [],
      getTemperature: () => 1,
      reasoningEffort: 'none',
      responsesVerbosity: 'low',
      aiProvider: 'openai',
      enableWebSearch: false,
      enableGoogleMaps: false,
      enableContextCache: false,
      geminiCacheTtlSeconds: 3600,
      maxOutputTokens: 1024,
      claudeThinkingBudgetTokens: 0,
      openaiTimeoutMs: 60000,
      openaiMaxRetries: 2,
      geminiTimeoutMs: 60000,
      claudeTimeoutMs: 60000
    });
    clearStubModuleCaches();
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: () => {},
      recordGauge: () => {},
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb()
    });
  });
  const fromError = new ProviderBusyError(new Error('rate limited'), 'rate_limit', 'gpt-5.4-nano');
  expect(fromError.name).toBe('ProviderBusyError');
  expect(fromError.message).toBe('rate limited');
  expect(fromError.reason).toBe('rate_limit');
  expect(fromError.attemptedModel).toBe('gpt-5.4-nano');

  const fromString = new ProviderBusyError('busy', 'overloaded', 'gpt-5.4-mini');
  expect(fromString.message).toBe('Provider busy');
});

test('should retries with fallback model when primary is overloaded', async () => {
  const modelsUsed = [];
  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      geminiApiKey: undefined,
      anthropicApiKey: undefined,
      modelName: 'gpt-5.4-nano',
      backupModels: [{ model: 'gpt-5.4-mini', provider: 'openai', tier: 'secondary' }],
      getTemperature: () => 1,
      reasoningEffort: 'none',
      responsesVerbosity: 'low',
      aiProvider: 'openai',
      enableWebSearch: false,
      enableGoogleMaps: false,
      enableContextCache: false,
      geminiCacheTtlSeconds: 3600,
      maxOutputTokens: 1024,
      claudeThinkingBudgetTokens: 0,
      openaiTimeoutMs: 60000,
      openaiMaxRetries: 2,
      geminiTimeoutMs: 60000,
      claudeTimeoutMs: 60000
    });
    global.__openaiStub = {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async ({ model }) => {
              modelsUsed.push(model);
              if (model === 'gpt-5.4-nano') {
                const err = new Error('overloaded');
                err.status = 503;
                throw err;
              }
              return {
                status: 'completed',
                output_text: 'fallback ok',
                id: 'r-fallback',
                usage: { total_tokens: 1 }
              };
            }
          };
        }
      }
    };
    clearStubModuleCaches();
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: () => {},
      recordGauge: () => {},
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb()
    });
  });

  const reply = await aiService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  expect(reply).toBe('fallback ok');
  expect(modelsUsed).toEqual(['gpt-5.4-nano', 'gpt-5.4-mini']);
});

test('should retries with cross-provider fallback when primary is overloaded', async () => {
  const providersUsed = [];
  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      geminiApiKey: 'fake',
      anthropicApiKey: undefined,
      modelName: 'gemini-3-flash-preview',
      backupModels: [{ model: 'gpt-5.4-mini', provider: 'openai', tier: 'secondary' }],
      getTemperature: () => 1,
      reasoningEffort: 'none',
      responsesVerbosity: 'low',
      aiProvider: 'gemini',
      enableWebSearch: false,
      enableGoogleMaps: false,
      enableContextCache: false,
      geminiCacheTtlSeconds: 3600,
      maxOutputTokens: 1024,
      claudeThinkingBudgetTokens: 0,
      openaiTimeoutMs: 60000,
      openaiMaxRetries: 2,
      geminiTimeoutMs: 60000,
      claudeTimeoutMs: 60000
    });
    global.__googleGenaiStub = {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: async () => {
              providersUsed.push('gemini');
              const err = new Error('resource exhausted');
              err.status = 429;
              throw err;
            }
          };
        }
      }
    };
    global.__openaiStub = {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async ({ model }) => {
              providersUsed.push('openai');
              return {
                status: 'completed',
                output_text: 'cross-provider ok',
                id: 'r-cross',
                usage: { total_tokens: 1 }
              };
            }
          };
        }
      }
    };
    clearStubModuleCaches();
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: () => {},
      recordGauge: () => {},
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb()
    });
  });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' }
  ]);
  expect(reply).toBe('cross-provider ok');
  expect(providersUsed).toEqual(['gemini', 'openai']);
});

test('should retries through two fallback tiers when each is overloaded', async () => {
  const attempts = [];
  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      geminiApiKey: undefined,
      anthropicApiKey: 'fake',
      modelName: 'gpt-5.4-nano',
      backupModels: [
        { model: 'gpt-5.4-mini', provider: 'openai', tier: 'secondary' },
        { model: 'claude-haiku-4-5', provider: 'claude', tier: 'tertiary' }
      ],
      getTemperature: () => 1,
      reasoningEffort: 'none',
      responsesVerbosity: 'low',
      aiProvider: 'openai',
      enableWebSearch: false,
      enableGoogleMaps: false,
      enableContextCache: false,
      geminiCacheTtlSeconds: 3600,
      maxOutputTokens: 1024,
      claudeThinkingBudgetTokens: 0,
      openaiTimeoutMs: 60000,
      openaiMaxRetries: 2,
      geminiTimeoutMs: 60000,
      claudeTimeoutMs: 60000
    });
    global.__openaiStub = {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async ({ model }) => {
              attempts.push(`openai:${model}`);
              if (model !== 'claude-haiku-4-5') {
                const err = new Error('overloaded');
                err.status = 503;
                throw err;
              }
              return {
                status: 'completed',
                output_text: 'unused',
                id: 'r-unused',
                usage: { total_tokens: 1 }
              };
            }
          };
        }
      }
    };
    global.__anthropicStub = class {
      constructor() {
        this.messages = {
          create: async ({ model }) => {
            attempts.push(`claude:${model}`);
            return {
              content: [{ type: 'text', text: 'second fallback ok' }]
            };
          }
        };
      }
    };
    clearStubModuleCaches();
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: () => {},
      recordGauge: () => {},
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb()
    });
  });

  const reply = await aiService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  expect(reply).toBe('second fallback ok');
  expect(attempts).toEqual([
    'openai:gpt-5.4-nano',
    'openai:gpt-5.4-mini',
    'claude:claude-haiku-4-5'
  ]);
});

test('should rethrows busy errors when fallback model is disabled', async () => {
  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      geminiApiKey: undefined,
      anthropicApiKey: undefined,
      modelName: 'gpt-5.4-nano',
      backupModels: [],
      getTemperature: () => 1,
      reasoningEffort: 'none',
      responsesVerbosity: 'low',
      aiProvider: 'openai',
      enableWebSearch: false,
      enableGoogleMaps: false,
      enableContextCache: false,
      geminiCacheTtlSeconds: 3600,
      maxOutputTokens: 1024,
      claudeThinkingBudgetTokens: 0,
      openaiTimeoutMs: 60000,
      openaiMaxRetries: 2,
      geminiTimeoutMs: 60000,
      claudeTimeoutMs: 60000
    });
    global.__openaiStub = {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async () => {
              const { ProviderBusyError } = require(aiServicePath);
              throw new ProviderBusyError(new Error('overloaded'), 'overloaded', 'gpt-5.4-nano');
            }
          };
        }
      }
    };
    clearStubModuleCaches();
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: () => {},
      recordGauge: () => {},
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb()
    });
  });

  await expect(aiService.generateAIResponse([{ role: 'user', content: 'hi' }])).rejects.toThrow(/overloaded/);
});

test('should gemini times out long requests', async () => {
  jest.useFakeTimers();
  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: undefined,
      geminiApiKey: 'fake',
      anthropicApiKey: undefined,
      modelName: 'gemini-2.0-flash',
      getTemperature: () => 1,
      reasoningEffort: 'none',
      responsesVerbosity: 'low',
      aiProvider: 'gemini',
      enableWebSearch: false,
      enableGoogleMaps: false,
      enableContextCache: false,
      geminiCacheTtlSeconds: 3600,
      maxOutputTokens: 1024,
      claudeThinkingBudgetTokens: 0,
      openaiTimeoutMs: 60000,
      openaiMaxRetries: 2,
      geminiTimeoutMs: 100,
      claudeTimeoutMs: 60000
    });
    global.__googleGenaiStub = {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: () => new Promise(() => {})
          };
        }
      }
    };
    clearStubModuleCaches();
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: () => {},
      recordGauge: () => {},
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb()
    });
  });

  const promise = aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' }
  ]);
  await jest.advanceTimersByTimeAsync(150);
  const reply = await promise;
  expect(reply).toMatch(/^⚠️/);
  jest.useRealTimers();
});

test('should logs backup model error_user_message outcome after fallback', async () => {
  const outcomes = [];
  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      geminiApiKey: undefined,
      anthropicApiKey: undefined,
      modelName: 'gpt-5.4-nano',
      backupModels: [{ model: 'gpt-5.4-mini', provider: 'openai', tier: 'secondary' }],
      getTemperature: () => 1,
      reasoningEffort: 'none',
      responsesVerbosity: 'low',
      aiProvider: 'openai',
      enableWebSearch: false,
      enableGoogleMaps: false,
      enableContextCache: false,
      geminiCacheTtlSeconds: 3600,
      maxOutputTokens: 1024,
      claudeThinkingBudgetTokens: 0,
      openaiTimeoutMs: 60000,
      openaiMaxRetries: 2,
      geminiTimeoutMs: 60000,
      claudeTimeoutMs: 60000
    });
    global.__openaiStub = {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async ({ model }) => {
              if (model === 'gpt-5.4-nano') {
                const err = new Error('overloaded');
                err.status = 503;
                throw err;
              }
              return {
                status: 'completed',
                output_text: '⚠️ backup user error',
                id: 'r-fallback',
                usage: { total_tokens: 1 }
              };
            }
          };
        }
      }
    };
    clearStubModuleCaches();
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: (_name, _value, attrs) => {
        if (attrs?.outcome) outcomes.push(attrs.outcome);
      },
      recordGauge: () => {},
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb()
    });
  });

  const reply = await aiService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  expect(reply).toBe('⚠️ backup user error');
  expect(outcomes).toContain('error_user_message');
});

test('should busy retry logging falls back when attemptedModel is missing', async () => {
  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      geminiApiKey: undefined,
      anthropicApiKey: undefined,
      modelName: 'gpt-5.4-nano',
      backupModels: [{ model: 'gpt-5.4-mini', provider: 'openai', tier: 'secondary' }],
      getTemperature: () => 1,
      reasoningEffort: 'none',
      responsesVerbosity: 'low',
      aiProvider: 'openai',
      enableWebSearch: false,
      enableGoogleMaps: false,
      enableContextCache: false,
      geminiCacheTtlSeconds: 3600,
      maxOutputTokens: 1024,
      claudeThinkingBudgetTokens: 0,
      openaiTimeoutMs: 60000,
      openaiMaxRetries: 2,
      geminiTimeoutMs: 60000,
      claudeTimeoutMs: 60000
    });
    global.__openaiStub = {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async ({ model }) => {
              if (model === 'gpt-5.4-nano') {
                const { ProviderBusyError } = require(aiServicePath);
                throw new ProviderBusyError('busy', 'overloaded');
              }
              return {
                status: 'completed',
                output_text: 'fallback ok',
                id: 'r-fallback',
                usage: { total_tokens: 1 }
              };
            }
          };
        }
      }
    };
    clearStubModuleCaches();
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: () => {},
      recordGauge: () => {},
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb()
    });
  });

  const reply = await aiService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  expect(reply).toBe('fallback ok');
});
