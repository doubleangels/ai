const path = require('path');
const { EventEmitter } = require('node:events');
const { withEnv, loadAiService, setSdkStubs, instrumentPath: sharedInstrumentPath } = require('./loadHelpers.cjs');
const { stubModule, reloadModule, DEFAULT_CONFIG, defaultInstrumentStub, clearStubRegistry, clearStubModuleCaches } = require('./testUtils.cjs');

const indexPath = path.resolve(__dirname, '..', 'index.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const messageCreatePath = path.resolve(__dirname, '..', 'events', 'messageCreate.js');
const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
const aiUtilsPath = path.resolve(__dirname, '..', 'utils', 'aiUtils.js');
const realAiUtils = require(aiUtilsPath);
const replyChainTracerPath = path.resolve(__dirname, '..', 'utils', 'replyChainTracer.js');
const deployPath = path.resolve(__dirname, '..', 'deploy-commands.js');
const resetPath = path.resolve(__dirname, '..', 'commands', 'reset.js');
const loggerPath = path.resolve(__dirname, '..', 'logger.js');
const pinoPath = require.resolve('pino');

function loadConfig(overrides) {
  return withEnv(overrides, () => {
    jest.unmock(configPath);
    return reloadModule(configPath);
  });
}

function loadMessageCreate(overrides = {}) {
  jest.unmock(configPath);
  jest.unmock(instrumentPath);
  jest.unmock(aiServicePath);
  jest.unmock(aiUtilsPath);
  jest.unmock(replyChainTracerPath);
  return reloadModule(messageCreatePath, () => {
    global.__discordStub = {
      Client: class {},
      Collection: class extends Map {},
      GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
      Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' },
      ActivityType: { Watching: 3 }
    };

    stubModule(configPath, {
      ...DEFAULT_CONFIG,
      userCooldownMs: 0,
      channelCooldownMs: 0,
      allowedGuildIds: new Set(),
      ...overrides.config
    });

    stubModule(aiServicePath, {
      generateAIResponse: overrides.generateAIResponse || (async () => 'ok')
    });
    stubModule(instrumentPath, defaultInstrumentStub({
      recordCount: overrides.recordCount
    }));

    stubModule(aiUtilsPath, { ...realAiUtils, ...(overrides.aiUtils || {}) });

    if (overrides.replyChainTracer) {
      stubModule(replyChainTracerPath, overrides.replyChainTracer);
    }
  });
}

function loadIndexHarness(recordCountImpl, configOverrides = {}, options = {}) {
  class FakeClient {
    constructor() {
      FakeClient.instance = this;
      this.commands = new Map();
      this.handlers = new Map();
      this.conversationHistory = new Map();
      this.channelLocks = new Map();
      this.user = { id: 'bot-123', tag: 'Bot#0001' };
      this.guilds = { cache: new Map() };
    }
    on(event, handler) {
      const list = this.handlers.get(event) || [];
      list.push(handler);
      this.handlers.set(event, list);
    }
    once(event, handler) { this.on(event, handler); }
    login() { return Promise.resolve(); }
  }

  const originalReaddir = require('fs').readdirSync;
  reloadModule(indexPath, () => {
    stubModule(configPath, { ...DEFAULT_CONFIG, ...configOverrides });
    stubModule(instrumentPath, defaultInstrumentStub({
      recordCount: options.recordCount || recordCountImpl
    }));

    global.__discordStub = {
      Client: FakeClient,
      Collection: Map,
      GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
      Options: { cacheWithLimits: limits => limits, DefaultMakeCacheSettings: {} },
      ActivityType: { Watching: 'Watching' }
    };

    require('fs').readdirSync = dir => {
      if (String(dir).endsWith(`${path.sep}commands`) || String(dir).endsWith(`${path.sep}events`)) return [];
      return originalReaddir(dir);
    };
  });

  require('fs').readdirSync = originalReaddir;
  return FakeClient.instance;
}

function createMessage(overrides = {}) {
  const client = {
    user: { id: 'bot-123', tag: 'AI#0001' },
    channelLocks: new Map(),
    channelQueueDepth: new Map(),
    userCooldowns: new Map(),
    channelCooldowns: new Map(),
    conversationHistory: new Map(),
    ...(overrides.client || {})
  };

  return {
    id: 'msg-1',
    content: '<@123> hello',
    channelId: 'chan-1',
    guildId: 'guild-1',
    channel: {
      name: 'general',
      messages: {
        fetch: async messageId => ({
          id: messageId,
          author: { id: 'bot-123', username: 'bot' },
          content: 'prior bot message',
          reference: null,
          attachments: { size: 0, values: () => [] }
        })
      }
    },
    client,
    author: { bot: false, id: 'user-1', tag: 'User#0001', username: 'user' },
    mentions: {
      has: () => true,
      users: { has: () => true },
      everyone: false,
      size: 1,
      values: () => [{ id: '123' }]
    },
    reference: null,
    attachments: new Map(),
    reply: async () => ({ edit: async () => {} }),
    ...overrides
  };
}

test('should falls back to provider defaults when model env vars are blank', async () => {
  const gemini = await loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: '   ',
    OPENAI_MODEL_NAME: '   '
  });
  expect(gemini.modelName).toBe('gemini-3-flash-preview');

  const geminiTrimmed = await loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: '  gemini-3-flash-preview  ',
    OPENAI_MODEL_NAME: undefined
  });
  expect(geminiTrimmed.modelName).toBe('gemini-3-flash-preview');

  const claude = await loadConfig({
    AI_PROVIDER: 'claude',
    CLAUDE_MODEL_NAME: '   ',
    OPENAI_MODEL_NAME: '   '
  });
  expect(claude.modelName).toBe('claude-sonnet-4-6');

  const openai = await loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: '   '
  });
  expect(openai.modelName).toBe('gpt-5.4-nano');
});

test('should index sends successful command error replies and swallows metric failures', async () => {
  let commandReplyMetrics = 0;
  const client = loadIndexHarness((_name, _value, attrs) => {
    if (attrs?.location === 'index.command_reply') {
      commandReplyMetrics += 1;
      if (commandReplyMetrics >= 2) throw new Error('metric failed');
    }
  });

  client.commands.set('cmd-boom', { execute: async () => { throw new Error('cmd failed'); } });
  const handlers = client.handlers.get('interactionCreate') || [];

  await handlers[0]({
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    commandName: 'cmd-boom',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'guild-1',
    inGuild: () => true,
    replied: false,
    deferred: false,
    reply: async () => {},
    followUp: async () => {}
  });

  commandReplyMetrics = 0;
  await handlers[0]({
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    commandName: 'cmd-boom',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'guild-1',
    inGuild: () => true,
    replied: false,
    deferred: false,
    reply: async () => {
      const err = new Error('rate limited');
      err.status = 429;
      throw err;
    },
    followUp: async () => {}
  });
  expect(commandReplyMetrics).toBe(2);

  delete require.cache[indexPath];
});

test('should index swallows context menu reply metric failures', async () => {
  let contextReplyMetrics = 0;
  const client = loadIndexHarness((_name, _value, attrs) => {
    if (attrs?.location === 'index.contextmenu_reply') {
      contextReplyMetrics += 1;
      if (contextReplyMetrics >= 2) throw new Error('metric failed');
    }
  });

  client.commands.set('ctx-boom', { execute: async () => { throw new Error('ctx failed'); } });
  const handlers = client.handlers.get('interactionCreate') || [];

  await handlers[1]({
    isChatInputCommand: () => false,
    isContextMenuCommand: () => true,
    commandName: 'ctx-boom',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'guild-1',
    inGuild: () => true,
    replied: false,
    deferred: false,
    reply: async () => {
      const err = new Error('rate limited');
      err.status = 429;
      throw err;
    },
    followUp: async () => {}
  });
  expect(contextReplyMetrics).toBe(2);

  let commandStatusCodeMetrics = 0;
  const client2 = loadIndexHarness((_name, _value, attrs) => {
    if (attrs?.location === 'index.command_reply') {
      commandStatusCodeMetrics += 1;
    }
  });
  client2.commands.set('cmd-boom', { execute: async () => { throw new Error('cmd failed'); } });
  const handlers2 = client2.handlers.get('interactionCreate') || [];
  await handlers2[0]({
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    commandName: 'cmd-boom',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'guild-1',
    inGuild: () => true,
    replied: true,
    deferred: false,
    reply: async () => {},
    followUp: async () => {
      const err = new Error('forbidden');
      err.statusCode = 403;
      throw err;
    }
  });
  expect(commandStatusCodeMetrics).toBe(1);
});

test('should records failures using statusCode and swallows metric errors', async () => {
  let deployMetrics = 0;
  const deploy = reloadModule(deployPath, () => {
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: (_name, _value, attrs) => {
        if (attrs?.location === 'deploy.register') {
          deployMetrics += 1;
          if (deployMetrics >= 2) throw new Error('metric failed');
        }
      },
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb(),
      closeSentry: async () => {}
    });

    stubModule(require.resolve('discord.js'), {
      SlashCommandBuilder: class { setName() { return this; } setDescription() { return this; } setDefaultMemberPermissions() { return this; } addChannelOption() { return this; } toJSON() { return {}; } },
      EmbedBuilder: class { setColor() { return this; } setTitle() { return this; } setDescription() { return this; } },
      ChannelType: { GuildText: 0 },
      PermissionFlagsBits: { Administrator: 0 },
      REST: class {
        setToken() { return this; }
        async put() {
          const err = new Error('rate limited');
          err.statusCode = 429;
          throw err;
        }
      },
      Routes: { applicationCommands: id => `/apps/${id}/cmds` }
    });
  });

  process.env.DISCORD_CLIENT_ID = 'client-1';
  await expect(deploy()).rejects.toThrow();
  expect(deployMetrics).toBe(2);

  deployMetrics = 0;
  const deployHttp = reloadModule(deployPath, () => {
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: (_name, _value, attrs) => {
        if (attrs?.location === 'deploy.register') deployMetrics += 1;
      },
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb(),
      closeSentry: async () => {}
    });

    stubModule(require.resolve('discord.js'), {
      SlashCommandBuilder: class { setName() { return this; } setDescription() { return this; } setDefaultMemberPermissions() { return this; } addChannelOption() { return this; } toJSON() { return {}; } },
      EmbedBuilder: class { setColor() { return this; } setTitle() { return this; } setDescription() { return this; } },
      ChannelType: { GuildText: 0 },
      PermissionFlagsBits: { Administrator: 0 },
      REST: class {
        setToken() { return this; }
        async put() {
          const err = new Error('forbidden');
          err.httpStatus = 403;
          throw err;
        }
      },
      Routes: { applicationCommands: id => `/apps/${id}/cmds` }
    });
  });
  await expect(deployHttp()).rejects.toThrow();
});

test('should reset handles missing guild metadata and all-channel error scope', async () => {
  const command = loadResetCommand();

  const interaction = {
    user: { id: 'admin-1', tag: 'Admin#0001' },
    guildId: 'guild-1',
    guild: null,
    client: {
      channelLocks: new Map(),
      conversationHistory: new Map([
        ['chan-1', [{ role: 'system', content: 'sys' }]]
      ])
    },
    options: { getChannel: () => null },
    deferReply: async () => {},
    editReply: async () => { throw new Error('edit failed'); },
    followUp: async () => {}
  };

  await expect(command.execute(interaction)).resolves.not.toThrow();

  const errorInteraction = {
    user: { id: 'admin-1', tag: 'Admin#0001' },
    guildId: 'guild-1',
    guild: { name: 'Test Guild' },
    client: {
      channelLocks: new Map(),
      conversationHistory: {
        keys: () => ['chan-1'].values(),
        size: 1,
        get: () => [{ role: 'system', content: 'sys' }],
        delete: () => { throw new Error('delete failed'); }
      }
    },
    options: { getChannel: () => null },
    deferReply: async () => {},
    editReply: async () => { throw new Error('edit failed'); },
    followUp: async () => { throw new Error('followUp failed'); }
  };

  await expect(command.execute(errorInteraction)).resolves.not.toThrow();
});

test('should logger uses default log level and forwards string-only messages to Sentry', () => {
  const sentryCalls = [];
  global.__pinoStub = Object.assign(
    () => ({ child: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} }) }),
    { stdTimeFunctions: { isoTime: () => new Date().toISOString() } }
  );

  const getLogger = reloadModule(loggerPath, () => {
    stubModule(configPath, { ...DEFAULT_CONFIG, logLevel: undefined });
    stubModule(instrumentPath, defaultInstrumentStub({
      Sentry: {
        logger: {
          info: message => sentryCalls.push(message)
        }
      }
    }));
  });

  const logger = getLogger('coverage-default-level');
  logger.info('plain message');
  expect(sentryCalls).toEqual(['plain message.']);
  clearStubRegistry();
});

function reloadAiServiceWith(setup) {
  jest.unmock(aiServicePath);
  jest.unmock(configPath);
  jest.unmock(instrumentPath);
  jest.unmock(aiUtilsPath);
  return reloadModule(aiServicePath, () => {
    stubModule(instrumentPath, defaultInstrumentStub());
    stubModule(configPath, { ...DEFAULT_CONFIG });
    if (setup) setup();
  });
}

function loadResetCommand() {
  return reloadModule(resetPath);
}

test('should records metrics without attributes', () => {
  const metricCalls = [];
  const instrument = reloadModule(instrumentPath, () => {
    jest.doMock('@sentry/node', () => ({
      init: () => {},
      isEnabled: () => true,
      metrics: {
        count: (...args) => metricCalls.push(['count', ...args]),
        gauge: (...args) => metricCalls.push(['gauge', ...args]),
        distribution: (...args) => metricCalls.push(['distribution', ...args])
      },
      withScope: undefined,
      captureException: () => {},
      startSpan: undefined,
      close: async () => {},
      getGlobalScope: () => ({ setAttributes() {} })
    }));
  });

  instrument.recordCount('metric.no_attrs');
  instrument.recordGauge('metric.no_attrs', 1);
  instrument.recordDistribution('metric.no_attrs', 2);
  expect(metricCalls.length).toBe(3);
  expect(metricCalls[0][3]).toEqual({});
});

test('should aiUtils covers remaining helper branches', () => {
  const aiUtils = require(aiUtilsPath);
  expect(aiUtils.estimateTokensFromText('')).toBe(0);
  expect(aiUtils.hasImages([{ role: 'user', content: 'text only' }])).toBe(false);
  expect(aiUtils.createMessageContent('', [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }])).toEqual([
    { type: 'input_image', image_url: 'data:image/png;base64,AA==' }
  ]);
  expect(aiUtils.trimConversationHistory([], 5).length).toBe(0);
  expect(aiUtils.trimConversationHistory(null, 5)).toBe(null);
});

test('should replyChainTracer uses Unknown author fallback', () => {
  const tracer = reloadModule(replyChainTracerPath);
  const chain = [
    {
      id: 'm1',
      content: 'hello',
      author: {},
      attachments: { size: 0 }
    },
    {
      id: 'm2',
      content: 'current',
      author: { username: 'alice' },
      attachments: { size: 0 }
    }
  ];
  expect(tracer.formatChainAsContext(chain)).toMatch(/Unknown: hello/);

  const shortChain = [
    { id: 'm1', content: 'short', author: { username: 'bob' }, attachments: { size: 0 } },
    { id: 'm2', content: 'current', author: { username: 'alice' }, attachments: { size: 0 } }
  ];
  expect(tracer.formatChainAsContext(shortChain)).toMatch(/bob: short/);
  expect(tracer.formatChainAsContext(shortChain)).not.toMatch(/\.\.\./);
});

test('should gemini cache creation failure, stale cache retry success, and Claude empty turns', async () => {
  const cacheFail = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => { throw new Error('cache create failed'); } };
          this.models = { generateContent: async () => ({ text: 'uncached ok' }) };
        }
      }
    }
  }, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'fake',
    ENABLE_CONTEXT_CACHE: '1'
  });
  expect(await cacheFail.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }])).toBe('uncached ok');

  let generateCalls = 0;
  const retrySuccess = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => ({ name: 'cache-live' }) };
          this.models = {
            generateContent: async ({ config }) => {
              generateCalls += 1;
              if (config.cachedContent) {
                const err = new Error('CachedContent NOT_FOUND expired');
                err.code = 404;
                throw err;
              }
              return { text: () => 'retry ok' };
            }
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'fake',
    ENABLE_CONTEXT_CACHE: '1'
  });
  expect(await retrySuccess.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }])).toBe('retry ok');
  expect(generateCalls >= 2).toBeTruthy();

  const regexStale = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => ({ name: 'cache-regex' }) };
          this.models = {
            generateContent: async ({ config }) => {
              if (config.cachedContent) {
                throw new Error('The cached content was deleted and NOT_FOUND');
              }
              return { text: 'regex retry ok' };
            }
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'fake',
    ENABLE_CONTEXT_CACHE: '1'
  });
  expect(await regexStale.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }])).toBe('regex retry ok');

  const retryFail = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.caches = { create: async () => ({ name: 'cache-fail' }) };
          this.models = {
            generateContent: async ({ config }) => {
              if (config.cachedContent) {
                const err = new Error('cachedcontent not found');
                err.status = 404;
                throw err;
              }
              throw new Error('retry failed');
            }
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'fake',
    ENABLE_CONTEXT_CACHE: '1'
  });
  expect(await retryFail.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }])).toMatch(/^⚠️ /);

  const imageOnlyGemini = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: async () => ({ text: 'image ok' })
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  expect(await imageOnlyGemini.generateAIResponse([
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }] }
    ])).toBe('image ok');

  const geminiAssistant = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: async () => ({ text: 'assistant ok' })
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  expect(await geminiAssistant.generateAIResponse([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'prior reply' },
      { role: 'user', content: 'follow up' }
    ])).toBe('assistant ok');

  const claudeEmpty = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = { create: async () => ({ content: [{ type: 'text', text: 'should not run' }] }) };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  expect(await claudeEmpty.generateAIResponse([{ role: 'system', content: 'sys only' }])).toMatch(/^⚠️ /);

  const claudeAssistant = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => ({ content: [{ type: 'text', text: 'claude ok' }] })
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  expect(await claudeAssistant.generateAIResponse([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'earlier' },
      { role: 'user', content: 'again' }
    ])).toBe('claude ok');
});

test('should covers cooldown failures, bot reply fetch, and fallback reply metrics', async () => {
  const userCooldownMod = loadMessageCreate({
    config: { userCooldownMs: 60_000, channelCooldownMs: 0 },
    recordCount: () => {}
  });
  await userCooldownMod.execute(createMessage({
    client: {
      user: { id: 'bot-123', tag: 'AI#0001' },
      channelLocks: new Map(),
      channelQueueDepth: new Map(),
      userCooldowns: new Map([['user-1', Date.now()]]),
      channelCooldowns: new Map(),
      conversationHistory: new Map()
    },
    reply: async payload => {
      if (payload.content?.includes('wait')) throw new Error('user cooldown reply failed');
      return { edit: async () => {} };
    }
  }));

  let fallbackMetrics = 0;
  const fallbackMod = loadMessageCreate({
    recordCount: (_name, _value, attrs) => {
      if (attrs?.location === 'messageCreate.reply_fallback') {
        fallbackMetrics += 1;
        if (fallbackMetrics >= 2) throw new Error('metric failed');
      }
    },
    aiUtils: {
      splitMessage: () => ['part-one'],
      processImageAttachments: async () => [],
      createMessageContent: text => [{ type: 'input_text', text }],
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: {
        IMAGE_ANALYSIS: 'image',
        BASE: () => 'system',
        BASE_GENERIC: 'system',
        IMAGE_DESCRIPTION_PROMPT: 'describe'
      }
    }
  });
  await fallbackMod.execute(createMessage({
    reply: async payload => {
      if (payload.content === '*Thinking...*') {
        return { edit: async () => { throw new Error('edit failed'); } };
      }
      const err = new Error('fallback failed');
      err.status = 429;
      throw err;
    }
  }));
  expect(fallbackMetrics).toBe(2);

  const botReplyMod = loadMessageCreate();
  await botReplyMod.execute(createMessage({
    reference: { messageId: 'ref-bot' },
    channel: {
      name: 'general',
      messages: {
        fetch: async () => ({
          id: 'ref-bot',
          author: { id: 'bot-123', username: 'bot' },
          content: 'bot prior',
          reference: null,
          attachments: { size: 0, values: () => [] }
        })
      }
    }
  }));

  const channelCooldownMod = loadMessageCreate({
    config: { userCooldownMs: 0, channelCooldownMs: 60_000 },
    recordCount: () => {}
  });
  await channelCooldownMod.execute(createMessage({
    client: {
      user: { id: 'bot-123', tag: 'AI#0001' },
      channelLocks: new Map(),
      channelQueueDepth: new Map(),
      userCooldowns: new Map(),
      channelCooldowns: new Map([['chan-1', Date.now()]]),
      conversationHistory: new Map()
    },
    reply: async payload => {
      if (payload.content?.includes('Give me')) throw new Error('channel cooldown reply failed');
      return { edit: async () => {} };
    }
  }));

  let editThinkingMetrics = 0;
  const editThinkingMod = loadMessageCreate({
    recordCount: (_name, _value, attrs) => {
      if (attrs?.location === 'messageCreate.edit_thinking') {
        editThinkingMetrics += 1;
        if (editThinkingMetrics >= 2) throw new Error('metric failed');
      }
    },
    aiUtils: {
      splitMessage: () => ['one'],
      processImageAttachments: async () => [],
      createMessageContent: text => [{ type: 'input_text', text }],
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: {
        IMAGE_ANALYSIS: 'image',
        BASE: () => 'system',
        BASE_GENERIC: 'system',
        IMAGE_DESCRIPTION_PROMPT: 'describe'
      }
    }
  });
  await editThinkingMod.execute(createMessage({
    reply: async payload => {
      if (payload.content === '*Thinking...*') {
        return {
          edit: async () => {
            const err = new Error('edit failed');
            err.status = 429;
            throw err;
          }
        };
      }
      return { edit: async () => {} };
    }
  }));
  expect(editThinkingMetrics).toBe(2);

  const thinkingFailMod = loadMessageCreate();
  await thinkingFailMod.execute(createMessage({
    reply: async payload => {
      if (payload.content === '*Thinking...*') throw new Error('thinking failed');
      return { edit: async () => {} };
    }
  }));
});

test('should rejects unknown mime types without content-type header', async () => {
  const aiUtils = require(aiUtilsPath);
  const https = require('node:https');
  const originalGet = https.get;

  https.get = (_url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.resume = () => {};
      callback(response);
    });
    return request;
  };

  try {
    await expect(aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png')).rejects.toThrow(/Unsupported content-type/);
  } finally {
    https.get = originalGet;
  }
});

test('should initializes missing client state maps', async () => {
  const mod = loadMessageCreate();
  const bareClient = {
    user: { id: 'bot-123' },
    conversationHistory: new Map()
  };
  await mod.execute(createMessage({ client: bareClient }));
  expect(bareClient.channelLocks instanceof Map).toBeTruthy();
  expect(bareClient.channelQueueDepth instanceof Map).toBeTruthy();
  expect(bareClient.userCooldowns instanceof Map).toBeTruthy();
  expect(bareClient.channelCooldowns instanceof Map).toBeTruthy();
});

test('should ignores bot authors and prefetch fetch failures', async () => {
  const mod = loadMessageCreate();
  await mod.execute(createMessage({
    author: { bot: true, id: 'bot-2', tag: 'Bot#2', username: 'bot' }
  }));

  let replied = false;
  await mod.execute(createMessage({
    content: 'reply only',
    mentions: { has: () => false, users: { has: () => false }, everyone: false, size: 0, values: () => [] },
    reference: { messageId: 'missing' },
    channel: {
      name: 'general',
      messages: { fetch: async () => { throw new Error('missing'); } }
    },
    reply: async () => { replied = true; return { edit: async () => {} }; }
  }));
  expect(replied).toBe(false);
});

test('should handles reply trigger and additional chunk rate limit metrics', async () => {
  let chunkMetrics = 0;
  const mod = loadMessageCreate({
    generateAIResponse: async () => 'a'.repeat(4100),
    recordCount: (_name, _value, attrs) => {
      if (attrs?.location === 'messageCreate.additional_chunk') {
        chunkMetrics += 1;
        if (chunkMetrics >= 2) throw new Error('metric failed');
      }
    },
    aiUtils: {
      splitMessage: text => [text.slice(0, 2000), text.slice(2000)],
      processImageAttachments: async () => [],
      createMessageContent: text => [{ type: 'input_text', text }],
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: {
        IMAGE_ANALYSIS: 'image',
        BASE: () => 'system',
        BASE_GENERIC: 'system',
        IMAGE_DESCRIPTION_PROMPT: 'describe'
      }
    }
  });

  await mod.execute(createMessage({
    content: 'reply only',
    mentions: { has: () => false, users: { has: () => false }, everyone: false, size: 0, values: () => [] },
    reference: { messageId: 'bot-msg' },
    client: {
      user: { id: 'bot-123' },
      channelLocks: new Map(),
      channelQueueDepth: new Map(),
      userCooldowns: new Map(),
      channelCooldowns: new Map(),
      conversationHistory: new Map()
    },
    channel: {
      name: 'general',
      messages: {
        fetch: async () => ({
          id: 'bot-msg',
          author: { id: 'bot-123', username: 'bot' },
          content: 'prior',
          reference: null,
          attachments: { size: 0, values: () => [] }
        })
      }
    },
    reply: async payload => {
      if (payload.content === '*Thinking...*') return { edit: async () => {} };
      const err = new Error('chunk rate limited');
      err.status = 429;
      throw err;
    }
  }));
  expect(chunkMetrics).toBe(2);
});

test('should index covers interaction handler guard branches and httpStatus fallbacks', async () => {
  let contextBlockedReply = false;
  const client = loadIndexHarness((_name, _value, attrs) => {
    if (attrs?.location === 'index.contextmenu_reply' && attrs?.httpStatus === 418) {
      throw new Error('metric failed');
    }
  });

  client.commands.set('ctx-boom', { execute: async () => { throw new Error('ctx failed'); } });
  const handlers = client.handlers.get('interactionCreate') || [];

  await handlers[0]({
    isChatInputCommand: () => false,
    isContextMenuCommand: () => true,
    commandName: 'ignored',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'guild-1',
    inGuild: () => true,
    reply: async () => {},
    followUp: async () => {}
  });

  await handlers[1]({
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    commandName: 'ignored',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'guild-1',
    inGuild: () => true,
    reply: async () => {},
    followUp: async () => {}
  });

  const blockedClient = loadIndexHarness(() => {}, { allowedGuildIds: new Set(['allowed-only']) });
  blockedClient.commands.set('ctx-boom', { execute: async () => {} });
  const blockedHandlers = blockedClient.handlers.get('interactionCreate') || [];
  await blockedHandlers[1]({
    isChatInputCommand: () => false,
    isContextMenuCommand: () => true,
    commandName: 'ctx-boom',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'wrong-guild',
    inGuild: () => true,
    reply: async () => { contextBlockedReply = true; throw new Error('blocked'); },
    followUp: async () => {}
  });
  expect(contextBlockedReply).toBe(true);

  const httpClient = loadIndexHarness(() => {});
  httpClient.commands.set('cmd-boom', { execute: async () => { throw new Error('cmd failed'); } });
  const httpHandlers = httpClient.handlers.get('interactionCreate') || [];
  await httpHandlers[0]({
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    commandName: 'cmd-boom',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'guild-1',
    inGuild: () => true,
    replied: false,
    deferred: false,
    reply: async () => {
      const err = new Error('teapot');
      err.httpStatus = 418;
      throw err;
    },
    followUp: async () => {}
  });

  await httpHandlers[1]({
    isChatInputCommand: () => false,
    isContextMenuCommand: () => true,
    commandName: 'ctx-boom',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'guild-1',
    inGuild: () => true,
    replied: false,
    deferred: false,
    reply: async () => {
      const err = new Error('teapot');
      err.httpStatus = 418;
      throw err;
    },
    followUp: async () => {}
  });
});

test('should resolves claude model from CLAUDE_MODEL_NAME', async () => {
  const config = await loadConfig({
    AI_PROVIDER: 'claude',
    CLAUDE_MODEL_NAME: 'claude-sonnet-4-6',
    OPENAI_MODEL_NAME: undefined
  });
  expect(config.modelName).toBe('claude-sonnet-4-6');
});

test('should reset initializes missing channelLocks on the client', async () => {
  const command = loadResetCommand();
  const interaction = {
    user: { id: 'admin-1', tag: 'Admin#0001' },
    guildId: 'guild-1',
    guild: { name: 'Test Guild' },
    client: {
      conversationHistory: new Map([
        ['chan-1', [{ role: 'system', content: 'sys' }]]
      ])
    },
    options: { getChannel: () => ({ id: 'chan-1', name: 'general' }) },
    deferReply: async () => {},
    editReply: async () => {},
    followUp: async () => {}
  };

  await expect(command.execute(interaction)).resolves.not.toThrow();
  expect(interaction.client.channelLocks instanceof Map).toBeTruthy();
});

test('should openAI and Claude branch coverage for optional request fields', async () => {
  setSdkStubs({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async () => ({
              status: 'completed',
              id: 'r1',
              usage: { total_tokens: 1 }
            })
          };
        }
      }
    }
  });

  const openaiService = reloadAiServiceWith(() => {
    stubModule(configPath, {
      ...DEFAULT_CONFIG,
      reasoningEffort: 42,
      responsesVerbosity: null
    });
  });
  expect(await openaiService.generateAIResponse([{ role: 'user', content: 'hi' }])).toMatch(/empty response/);

  let round = 0;
  global.__anthropicStub = function FakeAnthropic() {
    this.messages = {
      create: async () => {
        round += 1;
        if (round < 5) {
          return { content: [{ type: 'tool_use', id: `t-${round}`, name: 'unknown_tool', input: {} }] };
        }
        return {
          content: [
            { type: 'tool_use', id: 't-final', name: 'unknown_tool', input: {} },
            { type: 'text', text: 'final after max rounds' }
          ]
        };
      }
    };
  };
  clearStubModuleCaches();

  const claudeService = reloadAiServiceWith(() => {
    stubModule(configPath, {
      ...DEFAULT_CONFIG,
      aiProvider: 'claude',
      modelName: 'claude-sonnet-4-5'
    });
  });
  expect(await claudeService.generateAIResponse([{ role: 'user', content: 'hi' }])).toBe('final after max rounds');
  clearStubRegistry();
});

test('should gemini maps-only grounding and invalid image data URLs', async () => {
  const mapsOnly = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: async ({ config }) => {
              expect(config.tools).toEqual([{ googleMaps: {} }]);
              return { text: 'maps ok' };
            }
          };
        }
      }
    }
  }, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'fake',
    ENABLE_WEB_SEARCH: '0',
    ENABLE_GOOGLE_MAPS: '1'
  });
  expect(await mapsOnly.generateAIResponse([{ role: 'user', content: 'where' }])).toBe('maps ok');

  const invalidImage = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: async () => ({ text: 'no image parts' })
          };
        }
      }
    }
  }, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake' });
  expect(await invalidImage.generateAIResponse([
      { role: 'user', content: [{ type: 'input_image', image_url: 'not-a-data-url' }] }
    ])).toMatch(/^⚠️ /);
});

test('should aiUtils covers attachment and token helper branches', async () => {
  const aiUtils = require(aiUtilsPath);
  expect(await aiUtils.processImageAttachments(null)).toEqual([]);
  expect(await aiUtils.processImageAttachments([{ contentType: 'text/plain', url: 'https://cdn.discordapp.com/x.txt' }])).toEqual([]);

  const processed = await aiUtils.processImageAttachments([
    { contentType: 'image/png', url: 'https://cdn.discordapp.com/a.png', name: 'named.png' }
  ]);
  expect(processed.length).toBe(0);

  expect(aiUtils.trimConversationHistory([{ role: 'system', content: 'sys' }], 0, 0).length).toBe(1);

  const tokenHistory = [{ role: 'system', content: 'sys' }, { role: 'user', content: 123 }];
  aiUtils.trimConversationHistory(tokenHistory, 10, 5000);
  expect(tokenHistory.length).toBe(2);

  const utilsWithLimits = reloadModule(aiUtilsPath, () => {
    stubModule(configPath, {
      ...DEFAULT_CONFIG,
      imageDownloadTimeoutMs: 0,
      maxImageBytes: 0
    });
  });
  expect((await utilsWithLimits.processImageAttachments([
    { contentType: 'image/png', filename: 'pic.png', url: 'https://cdn.discordapp.com/not-real.png' }
  ])).length).toBe(0);
});

test('should replyChainTracer returns partial chains and empty message metadata', async () => {
  const tracer = reloadModule(replyChainTracerPath);

  const parent = {
    id: 'parent',
    content: 'parent text',
    author: { id: 'u1', username: 'alice', tag: 'alice#1', bot: false },
    get reference() {
      throw new Error('boom');
    },
    attachments: { size: 0 },
    createdTimestamp: 1
  };
  const start = {
    id: 'start',
    content: 'current',
    author: { id: 'u2', username: 'bob', tag: 'bob#1', bot: false },
    reference: { messageId: 'parent' },
    attachments: { size: 0 },
    createdTimestamp: 2
  };

  const channel = {
    id: 'chan-1',
    messages: {
      fetch: async id => (id === 'parent' ? parent : null)
    }
  };

  const partial = await tracer.traceReplyChain(start, channel);
  expect(partial.map(m => m.id)).toEqual(['parent', 'start']);

  const emptyStart = {
    id: 'solo',
    get reference() {
      throw new Error('boom');
    },
    content: 'solo',
    author: { id: 'u3', username: 'solo', tag: 'solo#1', bot: false },
    attachments: { size: 0 },
    createdTimestamp: 3
  };
  const recovered = await tracer.traceReplyChain(emptyStart, channel);
  expect(recovered.map(m => m.id)).toEqual(['solo']);

  const rows = await tracer.extractChainMessages([
    {
      id: 'm1',
      content: '',
      author: { id: 'u1', username: 'alice', tag: 'alice#1', bot: false },
      attachments: { size: 0 },
      createdTimestamp: 1
    }
  ]);
  expect(rows[0].content).toBe('');
});

test('should branch coverage for channel name, triggers, and reply paths', async () => {
  const mod = loadMessageCreate({ generateAIResponse: async () => 'ok' });

  await mod.execute(createMessage({
    content: 'no trigger',
    mentions: { has: () => false, users: { has: () => false }, everyone: false, size: 0, values: () => [] },
    reference: null
  }));

  await mod.execute(createMessage({
    channel: { name: undefined, messages: { fetch: async () => null } }
  }));

  const backpressureMod = loadMessageCreate({
    config: { maxPendingPerChannel: 1 },
    recordCount: () => {}
  });
  const busy = createMessage({
    channel: { name: 'general', messages: { fetch: async () => null } },
    reply: async () => {
      const err = new Error('busy');
      err.status = 500;
      throw err;
    }
  });
  busy.client.channelQueueDepth.set('chan-1', 1);
  await backpressureMod.execute(busy);

  const rateLimitedBusy = createMessage({
    reply: async () => {
      const err = new Error('rate limited');
      err.httpStatus = 429;
      throw err;
    }
  });
  rateLimitedBusy.client.channelQueueDepth.set('chan-1', 1);
  await backpressureMod.execute(rateLimitedBusy);

  const quotedMod = loadMessageCreate({ generateAIResponse: async () => 'done' });
  const parentUser = {
    id: 'parent-user',
    author: { id: 'user-2', username: 'bob', bot: false },
    content: 'prior user message',
    reference: null,
    attachments: { size: 0, values: () => [] }
  };
  const botMiddle = {
    id: 'parent-bot',
    author: { id: 'bot-123', username: 'bot', bot: true },
    content: 'bot said this',
    reference: { messageId: 'parent-user' },
    attachments: { size: 0, values: () => [] }
  };
  await quotedMod.execute(createMessage({
    content: '',
    mentions: { has: () => true, users: { has: () => true }, everyone: false, size: 1, values: () => [] },
    reference: { messageId: 'parent-bot' },
    channel: {
      name: 'general',
      messages: {
        fetch: async id => {
          if (id === 'parent-bot') return botMiddle;
          if (id === 'parent-user') return parentUser;
          return null;
        }
      }
    }
  }));

  const historyMod = loadMessageCreate({ generateAIResponse: async () => 'ok' });
  const historyMessage = createMessage({
    content: '<@123>',
    reference: { messageId: 'bot-msg' },
    channel: {
      name: 'general',
      messages: {
        fetch: async () => ({
          id: 'bot-msg',
          author: { id: 'bot-123' },
          content: 'same bot reply',
          reference: null,
          attachments: { size: 0, values: () => [] }
        })
      }
    },
    client: {
      user: { id: 'bot-123' },
      channelLocks: new Map(),
      channelQueueDepth: new Map(),
      userCooldowns: new Map(),
      channelCooldowns: new Map(),
      conversationHistory: new Map([
        ['chan-1', [
          { role: 'system', content: 'sys' },
          { role: 'assistant', content: 'same bot reply' }
        ]]
      ])
    }
  });
  await historyMod.execute(historyMessage);

  let chunkStatusCodeMetrics = 0;
  const chunkMod = loadMessageCreate({
    generateAIResponse: async () => 'a'.repeat(4100),
    recordCount: (_name, _value, attrs) => {
      if (attrs?.location === 'messageCreate.additional_chunk') chunkStatusCodeMetrics += 1;
    },
    aiUtils: {
      splitMessage: text => [text.slice(0, 2000), text.slice(2000)],
      processImageAttachments: async () => [],
      createMessageContent: text => [{ type: 'input_text', text }],
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: {
        IMAGE_ANALYSIS: 'image',
        BASE: () => 'system',
        BASE_GENERIC: 'system',
        IMAGE_DESCRIPTION_PROMPT: 'describe'
      }
    }
  });
  await chunkMod.execute(createMessage({
    reply: async payload => {
      if (payload.content === '*Thinking...*') return { edit: async () => {} };
      const err = new Error('chunk fail');
      err.httpStatus = 503;
      throw err;
    }
  }));
  expect(chunkStatusCodeMetrics).toBe(1);
});

test('should index covers remaining reply error and rejection branches', async () => {
  let contextHttpMetrics = 0;
  const client = loadIndexHarness(() => {}, {}, {
    recordCount: (_name, _value, attrs) => {
      if (attrs?.location === 'index.contextmenu_reply') contextHttpMetrics += 1;
    }
  });
  client.commands.set('ctx-boom', { execute: async () => { throw new Error('ctx failed'); } });
  const handlers = client.handlers.get('interactionCreate') || [];
  await handlers[1]({
    isChatInputCommand: () => false,
    isContextMenuCommand: () => true,
    commandName: 'ctx-boom',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'guild-1',
    inGuild: () => true,
    replied: false,
    deferred: false,
    reply: async () => {
      const err = new Error('teapot');
      err.httpStatus = 418;
      throw err;
    },
    followUp: async () => {}
  });
  expect(contextHttpMetrics).toBe(1);
  delete require.cache[indexPath];
});

test('should reset logs when error-path followUp succeeds after editReply fails', async () => {
  const command = loadResetCommand();
  const calls = [];
  const interaction = {
    user: { id: 'admin-1', tag: 'Admin#0001' },
    guildId: 'guild-1',
    guild: { name: 'Test Guild' },
    client: {
      channelLocks: new Map(),
      conversationHistory: {
        has: () => true,
        get: () => [{ role: 'system', content: 'sys' }],
        delete: () => { throw new Error('delete failed'); }
      }
    },
    options: { getChannel: () => ({ id: 'chan-1', name: 'general' }) },
    deferReply: async () => {},
    editReply: async () => { throw new Error('edit failed'); },
    followUp: async payload => { calls.push(payload); }
  };
  await command.execute(interaction);
  expect(calls.length).toBe(1);
});

test('should and aiUtils cover remaining model and download branches', async () => {
  const geminiOpenaiOnly = await loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: undefined,
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview'
  });
  expect(geminiOpenaiOnly.modelName).toBe('gemini-3-flash-preview');

  const aiUtilsLocal = require(aiUtilsPath);
  expect((await aiUtilsLocal.processImageAttachments(null)).length).toBe(0);
});

test('should replyChainTracer handles empty content in context formatting', () => {
  const tracer = reloadModule(replyChainTracerPath);
  const chain = [
    { id: 'm1', content: null, author: { username: 'bob' }, attachments: { size: 0 } },
    { id: 'm2', content: 'current', author: { username: 'alice' }, attachments: { size: 0 } }
  ];
  expect(tracer.formatChainAsContext(chain)).toMatch(/bob:/);
});

test('should records rate limit metrics and swallows metric failures', async () => {
  let recordCalls = 0;
  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    recordCount: () => {
      recordCalls += 1;
      if (recordCalls > 2) throw new Error('metric failed');
    },
    recordDistribution: () => {},
    startSpan: async (_opts, cb) => cb(),
    closeSentry: async () => {}
  });

  const discordPath = require.resolve('discord.js');
  stubModule(discordPath, {
    SlashCommandBuilder: class { setName() { return this; } setDescription() { return this; } setDefaultMemberPermissions() { return this; } addChannelOption() { return this; } toJSON() { return {}; } },
    EmbedBuilder: class { setColor() { return this; } setTitle() { return this; } setDescription() { return this; } },
    ChannelType: { GuildText: 0 },
    PermissionFlagsBits: { Administrator: 0 },
    REST: class { setToken() { return this; } async put() { const err = new Error('rate limited'); err.status = 429; throw err; } },
    Routes: { applicationCommands: id => `/apps/${id}/cmds` }
  });

  process.env.DISCORD_CLIENT_ID = 'client-1';
  delete require.cache[deployPath];
  const deploy = require(deployPath);
  await expect(deploy()).rejects.toThrow();
});


test('should index context menu reply failures record rate limits and metric errors', async () => {
  delete require.cache[indexPath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];

  let recordCalls = 0;
  stubModule(configPath, {
    token: 'fake',
    allowedGuildIds: new Set(['allowed-guild']),
    logLevel: 'info'
  });
  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    closeSentry: async () => { throw new Error('close failed'); },
    recordCount: (name, value, attrs) => {
      recordCalls += 1;
      const location = attrs?.location;
      if (location === 'index.command_reply' || location === 'index.contextmenu_reply') {
        if (recordCalls > 10) throw new Error('metric failed');
      }
    },
    recordGauge: () => {},
    recordDistribution: () => {},
    startSpan: async (_opts, cb) => cb()
  });

  const discordPath = require.resolve('discord.js');
  class FakeClient {
    constructor() {
      FakeClient.instance = this;
      this.commands = new Map();
      this.handlers = new Map();
      this.conversationHistory = new Map();
      this.channelLocks = new Map();
      this.user = { id: 'bot-123', tag: 'Bot#0001' };
      this.guilds = { cache: new Map() };
    }
    on(event, handler) {
      const list = this.handlers.get(event) || [];
      list.push(handler);
      this.handlers.set(event, list);
    }
    once(event, handler) { this.on(event, handler); }
    login() { return Promise.resolve(); }
  }

  stubModule(discordPath, {
    Client: FakeClient,
    Collection: Map,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
    Options: { cacheWithLimits: limits => limits, DefaultMakeCacheSettings: {} },
    ActivityType: { Watching: 'Watching' }
  });

  const captured = {};
  const originalOn = process.on;
  process.on = (event, handler) => { captured[event] = handler; return process; };
  const fs = require('fs');
  const originalReaddir = fs.readdirSync;
  fs.readdirSync = dir => {
    if (String(dir).endsWith(`${path.sep}commands`) || String(dir).endsWith(`${path.sep}events`)) return [];
    return originalReaddir(dir);
  };

  require(indexPath);
  const client = FakeClient.instance;
  client.commands.set('cmd-boom', { execute: async () => { throw new Error('cmd failed'); } });
  client.commands.set('ctx-boom', { execute: async () => { throw new Error('ctx failed'); } });

  const chatHandlers = client.handlers.get('interactionCreate') || [];
  await chatHandlers[0]({
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    commandName: 'cmd-boom',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'allowed-guild',
    inGuild: () => true,
    replied: false,
    deferred: false,
    reply: async () => {
      const err = new Error('rate limited');
      err.status = 429;
      throw err;
    },
    followUp: async () => {}
  });

  await chatHandlers[1]({
    isChatInputCommand: () => false,
    isContextMenuCommand: () => true,
    commandName: 'ctx-boom',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'blocked-guild',
    inGuild: () => true,
    replied: false,
    deferred: false,
    reply: async () => { throw new Error('blocked'); },
    followUp: async () => {}
  });

  await chatHandlers[1]({
    isChatInputCommand: () => false,
    isContextMenuCommand: () => true,
    commandName: 'ctx-boom',
    user: { id: 'u1', tag: 'User#1' },
    guildId: 'allowed-guild',
    inGuild: () => true,
    replied: false,
    deferred: false,
    reply: async () => {
      const err = new Error('rate limited');
      err.status = 429;
      throw err;
    },
    followUp: async () => {}
  });

  const originalExit = process.exit;
  process.exit = () => {};
  await captured.SIGTERM();
  await captured.SIGINT();
  process.exit = originalExit;
  process.on = originalOn;
  fs.readdirSync = originalReaddir;
  clearStubRegistry();
});


test('should covers thinking failures, chain tracing, and reply-chain images', async () => {
  let imageCallCount = 0;
  const parentWithImage = {
    id: 'parent',
    author: { id: 'user-2', username: 'bob', bot: false },
    content: 'prior',
    reference: null,
    attachments: { size: 1, values: () => [{ url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png' }] }
  };

  const mod = loadMessageCreate({
    generateAIResponse: async () => 'chain ok',
    replyChainTracer: {
      traceReplyChain: async (msg) => {
        if (msg.id === 'trace-fail') throw new Error('trace failed');
        return [parentWithImage, msg];
      },
      formatChainAsContext: () => '',
      extractChainMessages: async () => []
    },
    aiUtils: {
      processImageAttachments: async (attachments) => {
        imageCallCount += attachments.length;
        return [{ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }];
      },
      splitMessage: text => [text],
      createMessageContent: (text, images) => [{ type: 'input_text', text }, ...(images || [])],
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: {
        IMAGE_ANALYSIS: 'image',
        BASE: () => 'system',
        BASE_GENERIC: 'system',
        IMAGE_DESCRIPTION_PROMPT: 'describe'
      }
    }
  });

  const client = {
    user: { id: 'bot-123' },
    channelLocks: new Map(),
    channelQueueDepth: new Map(),
    userCooldowns: new Map(),
    channelCooldowns: new Map(),
    conversationHistory: new Map()
  };

  const reply = async payload => {
    if (payload.content === '*Thinking...*') throw new Error('thinking failed');
    return { edit: async () => {} };
  };

  const base = {
    content: '<@123>',
    guildId: 'guild-1',
    channel: { name: 'general', messages: { fetch: async () => parentWithImage } },
    client,
    author: { bot: false, id: 'user-1', tag: 'User#1', username: 'user' },
    mentions: { has: () => true, users: { has: () => true }, everyone: false, size: 1, values: () => [] },
    reference: { messageId: 'parent' },
    attachments: new Map(),
    reply
  };

  await mod.execute({ ...base, id: 'trace-fail', channelId: 'chan-2' });
  await mod.execute({ ...base, id: 'msg-1', channelId: 'chan-1' });
  expect(client.conversationHistory.has('chan-1')).toBeTruthy();
  expect(imageCallCount).toBe(1);
});


test('should aiService and aiUtils remaining branches', async () => {
  const aiUtils = reloadModule(aiUtilsPath);
  expect(() => aiUtils.assertDiscordImageDownloadUrl('http://cdn.discordapp.com/a.png')).toThrow(/HTTPS/);

  const openaiService = await loadAiService({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = {
            create: async () => ({ status: 'incomplete', output_text: '   ', id: 'r1' })
          };
        }
      }
    }
  }, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' });
  expect(await openaiService.generateAIResponse([
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }] }
  ])).toMatch(/empty response/);

  setSdkStubs({
    openai: {
      OpenAI: class {
        constructor() {
          this.responses = { create: async () => ({ status: 'completed', id: 'r1' }) };
        }
      }
    }
  });
  const throwingService = reloadModule(aiServicePath, () => {
    stubModule(instrumentPath, defaultInstrumentStub());
    stubModule(configPath, { ...DEFAULT_CONFIG });
    stubModule(aiUtilsPath, {
      ...realAiUtils,
      hasImages: () => { throw new Error('hasImages failed'); },
      SYSTEM_MESSAGES: { IMAGE_ANALYSIS: 'image analysis' }
    });
  });
  expect(await throwingService.generateAIResponse([{ role: 'user', content: 'hi' }])).toMatch(/^⚠️ /);

  clearStubRegistry();
  const claudeService = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => ({ content: [{ type: 'text', text: 'ok' }] })
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  expect(await claudeService.generateAIResponse([
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }] }
  ])).toBe('ok');

  const config = await loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: 'gemini-3-flash-preview',
    OPENAI_MODEL_NAME: undefined
  });
  expect(config.modelName).toBe('gemini-3-flash-preview');
});
