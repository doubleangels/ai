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
    OPENAI_MODEL_NAME: 'gpt-6-luna',
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
  expect(capturedRequest.model).toBe('gpt-6-luna');
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
  let capturedParams;
  const aiService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async params => {
          capturedParams = params;
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
  // API version 2026-10-21 rejects sampling params on Messages requests.
  expect(capturedParams).not.toHaveProperty('temperature');
  expect(capturedParams).not.toHaveProperty('top_p');
  expect(capturedParams).not.toHaveProperty('top_k');
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

  // Large enough prefix (~3k estimated tokens) to pass CLAUDE_CACHE_MIN_TOKENS (default 2048).
  const longReply = 'reply '.repeat(2000);
  await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: longReply },
    { role: 'user', content: 'second' }
  ]);
  // One breakpoint on the turn before the latest user message caches the whole prefix.
  expect(capturedSystem).toBe('sys');
  expect(capturedMessages[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
  expect(capturedMessages[2].content).toBe('second');

  // Small conversations are not marked: below the threshold a cache write would rarely pay off.
  await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' }
  ]);
  expect(capturedMessages[1].content).toBe('reply');
});

test('should claude never puts cache_control on thinking blocks during tool rounds', async () => {
  const calls = [];
  const aiService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async params => {
          calls.push(JSON.parse(JSON.stringify(params)));
          if (calls.length === 1) {
            return {
              content: [
                { type: 'thinking', thinking: '', signature: 'sig' },
                { type: 'tool_use', id: 'tool-1', name: 'get_current_time', input: {} },
                { type: 'thinking', thinking: '', signature: 'sig2' }
              ],
              usage: { input_tokens: 10, output_tokens: 5 }
            };
          }
          return {
            content: [{ type: 'text', text: 'It is noon.' }],
            usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 3000 }
          };
        }
      };
    }
  }, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'fake',
    ENABLE_CONTEXT_CACHE: '1',
    CLAUDE_MODEL_NAME: 'claude-opus-5-5'
  });

  const reply = await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'background '.repeat(2000) },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'what time is it' }
  ]);
  expect(reply).toBe('It is noon.');
  const toolRoundAssistant = calls[1].messages[calls[1].messages.length - 2];
  expect(toolRoundAssistant.content[1].cache_control).toEqual({ type: 'ephemeral' });
  expect(toolRoundAssistant.content[0].cache_control).toBeUndefined();
  expect(toolRoundAssistant.content[2].cache_control).toBeUndefined();
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
  // gpt-6-luna (default) isn't documented for 24h retention; it uses the default 30m cache.
  expect(capturedParams).not.toHaveProperty('prompt_cache_retention');
  // cache_control is an Anthropic field; OpenAI caches prefixes automatically.
  expect(JSON.stringify(capturedParams.input)).not.toMatch(/cache_control/);
  expect(capturedParams.input[2].content).toBe('reply');
});

test('should skip cache breakpoints when the only user turn is first', async () => {
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

  const reply = await aiService.generateAIResponse([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'prev' }
  ]);

  expect(reply).toBe('ok');
  expect(capturedParams.input.every(msg => {
    const content = msg.content;
    if (!Array.isArray(content)) return true;
    return content.every(part => !part.cache_control);
  })).toBe(true);
});

test('should leave the cache breakpoint message untouched when it has no cacheable content', async () => {
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

  const reply = await aiService.generateAIResponse([
    { role: 'assistant', content: [] },
    { role: 'user', content: 'second' }
  ]);

  expect(reply).toBe('ok');
  expect(capturedParams.input[0].content).toEqual([]);
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
  expect(capturedSystem).toMatch(/When analyzing images/);
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
    OPENAI_MODEL_NAME: 'claude-haiku-4-5',
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
  // The unusable user turn is dropped, leaving only an assistant turn: Claude would reject that
  // (assistant prefill / no user turn), so the bot reports an error instead of sending it.
  expect(await oddContent.generateAIResponse([
    { role: 'assistant', content: 'ignored' },
    { role: 'user', content: { not: 'text' } }
  ])).toMatch(/^⚠️/);

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
      modelName: 'gpt-6-luna',
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
      modelName: 'gpt-6-luna',
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
      modelName: 'gpt-6-luna',
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
          // Reading usage throws after the request succeeds, which only the outer catch handles.
          this.responses = {
            create: async () => ({
              status: 'completed',
              output_text: 'ok',
              id: 'r1',
              get usage() {
                throw { message: 'bare failure' };
              }
            })
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
  expect(reply).toMatch(/^⚠️/);
});

test('should generateAIResponse catch uses unknown provider when config is empty', async () => {
  const captured = [];
  const aiService = reloadModule(aiServicePath, () => {
    stubModule(configPath, {
      openaiApiKey: 'fake',
      geminiApiKey: undefined,
      anthropicApiKey: undefined,
      modelName: 'gpt-6-luna',
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
      modelName: 'gpt-6-luna',
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
  const fromError = new ProviderBusyError(new Error('rate limited'), 'rate_limit', 'gpt-6-luna');
  expect(fromError.name).toBe('ProviderBusyError');
  expect(fromError.message).toBe('rate limited');
  expect(fromError.reason).toBe('rate_limit');
  expect(fromError.attemptedModel).toBe('gpt-6-luna');

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
      modelName: 'gpt-6-luna',
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
              if (model === 'gpt-6-luna') {
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
  expect(modelsUsed).toEqual(['gpt-6-luna', 'gpt-5.4-mini']);
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
      modelName: 'gpt-6-luna',
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
    'openai:gpt-6-luna',
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
      modelName: 'gpt-6-luna',
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
              throw new ProviderBusyError(new Error('overloaded'), 'overloaded', 'gpt-6-luna');
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
      modelName: 'gpt-6-luna',
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
              if (model === 'gpt-6-luna') {
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
      modelName: 'gpt-6-luna',
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
              if (model === 'gpt-6-luna') {
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

function captureClaudeParams() {
  const calls = [];
  const FakeAnthropic = function FakeAnthropic() {
    this.messages = {
      create: async params => {
        calls.push(params);
        return { content: [{ type: 'text', text: 'ok' }] };
      }
    };
  };
  return { calls, FakeAnthropic };
}

async function claudeParamsFor(env) {
  const { calls, FakeAnthropic } = captureClaudeParams();
  const aiService = await loadAiService({ anthropic: FakeAnthropic }, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'fake',
    CLAUDE_THINKING_BUDGET_TOKENS: undefined,
    CLAUDE_EFFORT: undefined,
    ...env
  });
  await aiService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  return calls[0];
}

test('should claude use budget_tokens thinking only on 4.5 models', async () => {
  const params = await claudeParamsFor({ CLAUDE_MODEL_NAME: 'claude-haiku-4-5', CLAUDE_THINKING_BUDGET_TOKENS: '2048' });
  expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  expect(params.max_tokens).toBe(1024 + 2048);
  expect(params.output_config).toBeUndefined();
});

test('should claude use adaptive thinking on 4.6-4.8 models when requested, and none otherwise', async () => {
  const on = await claudeParamsFor({ CLAUDE_MODEL_NAME: 'claude-opus-4-7', CLAUDE_THINKING_BUDGET_TOKENS: '4096' });
  expect(on.thinking).toEqual({ type: 'adaptive' });
  expect(on.max_tokens).toBe(1024 + 4096);

  const off = await claudeParamsFor({ CLAUDE_MODEL_NAME: 'claude-opus-4-7' });
  expect(off.thinking).toBeUndefined();
  expect(off.max_tokens).toBe(1024);
});

test('should claude send no thinking field to always-thinking models and pass effort', async () => {
  const params = await claudeParamsFor({ CLAUDE_MODEL_NAME: 'claude-opus-5-5', CLAUDE_EFFORT: 'low' });
  expect(params).not.toHaveProperty('thinking');
  expect(params).not.toHaveProperty('temperature');
  expect(params.output_config).toEqual({ effort: 'low' });
  // Headroom for thinking, but never above the SDK's non-streaming limit.
  expect(params.max_tokens).toBe(1024 + 8192);
  expect(params.max_tokens).toBeLessThanOrEqual(20000);
});

test('should claude map or drop effort for models with narrower effort support', async () => {
  expect((await claudeParamsFor({ CLAUDE_MODEL_NAME: 'claude-sonnet-4-6', CLAUDE_EFFORT: 'xhigh' })).output_config)
    .toEqual({ effort: 'high' });
  expect((await claudeParamsFor({ CLAUDE_MODEL_NAME: 'claude-haiku-4-5', CLAUDE_EFFORT: 'low' })).output_config)
    .toBeUndefined();
});

test('should claude cap max_tokens below the SDK non-streaming limit', async () => {
  const params = await claudeParamsFor({
    CLAUDE_MODEL_NAME: 'claude-haiku-4-5',
    CLAUDE_THINKING_BUDGET_TOKENS: '32000',
    MAX_OUTPUT_TOKENS: '8000'
  });
  expect(params.max_tokens).toBe(20000);
  expect(params.thinking.budget_tokens).toBeLessThan(params.max_tokens);
});

test('should record normalized token usage for each provider', async () => {
  const recorded = [];
  const instrument = {
    recordDistribution: (name, value, options) => {
      if (name.startsWith('ai.tokens.')) recorded.push([name, value, options.attributes.provider]);
    }
  };

  const openaiService = await loadAiService({
    instrument,
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async () => ({
              id: 'r1',
              status: 'completed',
              output_text: 'hi',
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                input_tokens_details: { cached_tokens: 64 },
                output_tokens_details: { reasoning_tokens: 0 }
              }
            })
          };
        }
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });
  await openaiService.generateAIResponse([{ role: 'user', content: 'hi' }]);

  const geminiService = await loadAiService({
    instrument,
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: async () => ({
              text: 'hi',
              usageMetadata: { promptTokenCount: 50, toolUsePromptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 }
            })
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  await geminiService.generateAIResponse([{ role: 'user', content: 'hi' }]);

  const claudeService = await loadAiService({
    instrument,
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => ({
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 30, output_tokens: 8, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 }
        })
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  await claudeService.generateAIResponse([{ role: 'user', content: 'hi' }]);

  expect(recorded).toEqual(expect.arrayContaining([
    ['ai.tokens.input', 100, 'openai'],
    ['ai.tokens.output', 20, 'openai'],
    ['ai.tokens.cached_input', 64, 'openai'],
    ['ai.tokens.input', 60, 'gemini'],
    ['ai.tokens.output', 5, 'gemini'],
    ['ai.tokens.reasoning', 7, 'gemini'],
    // Claude: uncached + cache read + cache write are all prompt tokens.
    ['ai.tokens.input', 240, 'claude'],
    ['ai.tokens.cached_input', 200, 'claude'],
    ['ai.tokens.cache_write', 10, 'claude'],
    ['ai.tokens.output', 8, 'claude']
  ]));
});

test('should pin Gemini chat to v1beta unless GOOGLE_GENAI_API_VERSION is set', async () => {
  const constructorOptions = [];
  const genai = {
    GoogleGenAI: class {
      constructor(options) {
        constructorOptions.push(options);
        this.models = { generateContent: async () => ({ text: 'ok' }) };
      }
    }
  };
  await loadAiService({ genai }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', GOOGLE_GENAI_API_VERSION: undefined });
  await loadAiService({ genai }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', GOOGLE_GENAI_API_VERSION: 'v1' });
  expect(constructorOptions[0].apiVersion).toBe('v1beta');
  expect(constructorOptions[1]).not.toHaveProperty('apiVersion');
});

test('should tolerate partial usage objects', async () => {
  const recorded = [];
  const instrument = {
    recordDistribution: (name, value) => {
      if (name.startsWith('ai.tokens.')) recorded.push([name, value]);
    }
  };
  const geminiService = await loadAiService({
    instrument,
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = { generateContent: async () => ({ text: 'ok', usageMetadata: { candidatesTokenCount: 3 } }) };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  await geminiService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  expect(recorded).toEqual([['ai.tokens.input', 0], ['ai.tokens.output', 3]]);

  recorded.length = 0;
  const claudeService = await loadAiService({
    instrument,
    anthropic: function FakeAnthropic() {
      this.messages = { create: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }) };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  await claudeService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  expect(recorded).toEqual(expect.arrayContaining([['ai.tokens.input', 0], ['ai.tokens.output', 0]]));
});

test('should claude skip the cache breakpoint when there is no earlier turn or the last turn is not a user turn', async () => {
  const { calls, FakeAnthropic } = captureClaudeParams();
  const aiService = await loadAiService({ anthropic: FakeAnthropic }, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'fake',
    ENABLE_CONTEXT_CACHE: '1'
  });
  const longText = 'context '.repeat(2000);

  await aiService.generateAIResponse([{ role: 'user', content: longText }]);
  await aiService.generateAIResponse([
    { role: 'user', content: longText },
    { role: 'assistant', content: 'prev' }
  ]);

  for (const call of calls) {
    expect(JSON.stringify(call.messages)).not.toMatch(/cache_control/);
  }
});

test('should claude rethrow busy errors to the backup model and still record billed usage', async () => {
  const recorded = [];
  let claudeCalls = 0;
  const aiService = await loadAiService({
    instrument: {
      recordDistribution: (name, value, options) => {
        if (name.startsWith('ai.tokens.')) recorded.push([name, value, options.attributes.provider]);
      }
    },
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => {
          claudeCalls += 1;
          if (claudeCalls === 1) {
            // First round asks for a tool, so tokens are billed before the overload error.
            return {
              content: [{ type: 'tool_use', id: 't1', name: 'get_current_time', input: {} }],
              usage: { input_tokens: 12, output_tokens: 3 }
            };
          }
          const error = new Error('Overloaded');
          error.status = 529;
          throw error;
        }
      };
    },
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = { create: async () => ({ id: 'r', status: 'completed', output_text: 'backup reply' }) };
        }
      }
    }
  }, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'fake',
    OPENAI_API_KEY: 'fake',
    SECONDARY_MODEL_NAME: 'gpt-5.4-mini'
  });

  const reply = await aiService.generateAIResponse([{ role: 'user', content: 'what time is it' }]);
  expect(reply).toBe('backup reply');
  expect(recorded).toEqual(expect.arrayContaining([['ai.tokens.input', 12, 'claude'], ['ai.tokens.output', 3, 'claude']]));
});

async function openaiParamsFor(env) {
  let captured;
  const aiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async params => {
              captured = params;
              return { id: 'r', status: 'completed', output_text: 'ok' };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake', REASONING_EFFORT: undefined, ...env });
  await aiService.generateAIResponse([{ role: 'user', content: 'hi' }]);
  return captured;
}

test('should openai raise reasoning effort to each model minimum and never send temperature', async () => {
  const luna = await openaiParamsFor({ OPENAI_MODEL_NAME: 'gpt-6-luna' });
  expect(luna.reasoning).toEqual({ effort: 'none' });
  expect(luna.max_output_tokens).toBe(1024);
  expect(luna).not.toHaveProperty('temperature');

  const astra = await openaiParamsFor({ OPENAI_MODEL_NAME: 'gpt-6-astra', REASONING_EFFORT: 'none' });
  expect(astra.reasoning).toEqual({ effort: 'low' });
  // Reasoning tokens count against max_output_tokens, so the cap gets headroom.
  expect(astra.max_output_tokens).toBe(1024 + 25000);

  const pro = await openaiParamsFor({ OPENAI_MODEL_NAME: 'gpt-5.5-pro', REASONING_EFFORT: 'low' });
  expect(pro.reasoning).toEqual({ effort: 'medium' });

  const high = await openaiParamsFor({ OPENAI_MODEL_NAME: 'gpt-6.1-sol', REASONING_EFFORT: 'high' });
  expect(high.reasoning).toEqual({ effort: 'high' });

  // An invalid value counts as 'none' so the model default (often medium) never applies silently.
  const invalid = await openaiParamsFor({ OPENAI_MODEL_NAME: 'gpt-5.4-mini', REASONING_EFFORT: 'turbo' });
  expect(invalid.reasoning).toEqual({ effort: 'none' });
});

test('should openai send 24h cache retention only to models documented for it', async () => {
  expect((await openaiParamsFor({ OPENAI_MODEL_NAME: 'gpt-5.5', ENABLE_CONTEXT_CACHE: '1' })).prompt_cache_retention).toBe('24h');
  expect((await openaiParamsFor({ OPENAI_MODEL_NAME: 'gpt-5.4-mini', ENABLE_CONTEXT_CACHE: '1' }))).not.toHaveProperty('prompt_cache_retention');
  expect((await openaiParamsFor({ OPENAI_MODEL_NAME: 'gpt-6.1-sol', ENABLE_CONTEXT_CACHE: '1' }))).not.toHaveProperty('prompt_cache_retention');
});

test('should gemini drop temperature, add thinking headroom, and fix turn order and unsupported images', async () => {
  let captured;
  const aiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: async params => {
              captured = params;
              return { text: 'ok' };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', GEMINI_MODEL_NAME: 'gemini-3.8-flash' });

  await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'bot message being replied to' },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this?' },
        { type: 'input_image', image_url: 'data:image/gif;base64,R0lG' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBO' }
      ]
    },
    { role: 'assistant', content: 'trailing model turn' }
  ]);

  expect(captured.config).not.toHaveProperty('temperature');
  expect(captured.config.maxOutputTokens).toBe(1024 + 8192);
  expect(captured.contents[0]).toEqual({ role: 'user', parts: [{ text: '[Earlier conversation]' }] });
  expect(captured.contents[1].role).toBe('model');
  const last = captured.contents[captured.contents.length - 1];
  expect(last.role).toBe('user');
  expect(last.parts).toEqual([
    { text: 'what is this?' },
    { text: '[An attached image/gif image could not be analyzed.]' },
    { inlineData: { mimeType: 'image/png', data: 'iVBO' } }
  ]);
});

test('should gemini never create explicit caches for Gemini 4 models', async () => {
  let cacheCreates = 0;
  let captured;
  const aiService = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => { cacheCreates += 1; return { name: 'c' }; } };
          this.models = {
            generateContent: async params => {
              captured = params;
              return { text: 'ok' };
            }
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake', GEMINI_MODEL_NAME: 'gemini-4-hydrogen', ENABLE_CONTEXT_CACHE: '1' });

  await aiService.generateAIResponse([
    { role: 'system', content: 'long system prompt '.repeat(400) },
    { role: 'user', content: 'hi' }
  ]);
  expect(cacheCreates).toBe(0);
  expect(captured.config).not.toHaveProperty('cachedContent');
  expect(captured.config.systemInstruction).toMatch(/long system prompt/);
});

test('should claude add a leading user turn and drop trailing assistant turns', async () => {
  const { calls, FakeAnthropic } = captureClaudeParams();
  const aiService = await loadAiService({ anthropic: FakeAnthropic }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  await aiService.generateAIResponse([
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'bot message being replied to' },
    { role: 'user', content: 'follow up' },
    { role: 'assistant', content: 'trailing' }
  ]);
  expect(calls[0].messages).toEqual([
    { role: 'user', content: '[Earlier conversation]' },
    { role: 'assistant', content: 'bot message being replied to' },
    { role: 'user', content: 'follow up' }
  ]);
});

test('should claude ignore non-text user content when checking for time questions', async () => {
  const { calls, FakeAnthropic } = captureClaudeParams();
  const aiService = await loadAiService({ anthropic: FakeAnthropic }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  const reply = await aiService.generateAIResponse([
    { role: 'user', content: 'what time is it' },
    { role: 'assistant', content: 'noon' },
    { role: 'user', content: { not: 'text' } }
  ]);
  expect(reply).toBe('ok');
  // The unusable last user turn is dropped from the request and doesn't trigger the time tool.
  expect(calls[0].messages).toEqual([{ role: 'user', content: 'what time is it' }]);
  expect(calls[0]).not.toHaveProperty('tools');
});
