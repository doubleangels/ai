const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('node:events');

const indexPath = path.resolve(__dirname, '..', 'index.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const messageCreatePath = path.resolve(__dirname, '..', 'events', 'messageCreate.js');
const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
const aiUtilsPath = path.resolve(__dirname, '..', 'utils', 'aiUtils.js');
const replyChainTracerPath = path.resolve(__dirname, '..', 'utils', 'replyChainTracer.js');
const deployPath = path.resolve(__dirname, '..', 'deploy-commands.js');
const resetPath = path.resolve(__dirname, '..', 'commands', 'reset.js');
const loggerPath = path.resolve(__dirname, '..', 'logger.js');
const pinoPath = require.resolve('pino');

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

function loadConfig(overrides) {
  return withEnv(overrides, () => {
    delete require.cache[configPath];
    return require(configPath);
  });
}

function loadAiService({ openai, genai, anthropic, instrument: instrumentOverrides = {} } = {}, env = {}) {
  delete require.cache[aiServicePath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];

  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
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

function loadMessageCreate(overrides = {}) {
  delete require.cache[messageCreatePath];
  delete require.cache[aiServicePath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];
  delete require.cache[aiUtilsPath];

  const discordPath = require.resolve('discord.js');
  delete require.cache[discordPath];
  const discord = require(discordPath);
  stubModule(discordPath, {
    ...discord,
    Events: { ...discord.Events, MessageCreate: 'messageCreate' }
  });

  const baseConfig = require(configPath);
  stubModule(configPath, {
    ...baseConfig,
    userCooldownMs: 0,
    channelCooldownMs: 0,
    allowedGuildIds: new Set(),
    ...overrides.config
  });

  stubModule(aiServicePath, {
    generateAIResponse: overrides.generateAIResponse || (async () => 'ok')
  });
  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false, setConversationId: () => {} },
    captureError: () => {},
    recordCount: overrides.recordCount || (() => {}),
    recordDistribution: () => {},
    recordGauge: () => {},
    startSpan: async (_opts, cb) => cb()
  });

  if (overrides.aiUtils) {
    stubModule(aiUtilsPath, { ...require(aiUtilsPath), ...overrides.aiUtils });
  }

  return require(messageCreatePath);
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

function loadIndexHarness(recordCountImpl, configOverrides = {}, options = {}) {
  delete require.cache[indexPath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];

  stubModule(configPath, {
    token: 'fake',
    allowedGuildIds: new Set(),
    logLevel: 'info',
    ...configOverrides
  });
  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    closeSentry: async () => {},
    recordCount: options.recordCount || recordCountImpl || (() => {}),
    recordGauge: () => {},
    recordDistribution: () => {},
    startSpan: async (_opts, cb) => cb()
  });

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

  stubModule(require.resolve('discord.js'), {
    Client: FakeClient,
    Collection: Map,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
    Options: { cacheWithLimits: limits => limits, DefaultMakeCacheSettings: {} },
    ActivityType: { Watching: 'Watching' }
  });

  const fs = require('fs');
  const originalReaddir = fs.readdirSync;
  fs.readdirSync = dir => {
    if (String(dir).endsWith(`${path.sep}commands`) || String(dir).endsWith(`${path.sep}events`)) return [];
    return originalReaddir(dir);
  };

  require(indexPath);
  const client = FakeClient.instance;
  fs.readdirSync = originalReaddir;
  return client;
}

test('config falls back to provider defaults when model env vars are blank', async () => {
  const gemini = await loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: '   ',
    OPENAI_MODEL_NAME: '   '
  });
  assert.equal(gemini.modelName, 'gemini-3-flash-preview');

  const geminiTrimmed = await loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: '  gemini-3-flash-preview  ',
    OPENAI_MODEL_NAME: undefined
  });
  assert.equal(geminiTrimmed.modelName, 'gemini-3-flash-preview');

  const claude = await loadConfig({
    AI_PROVIDER: 'claude',
    CLAUDE_MODEL_NAME: '   ',
    OPENAI_MODEL_NAME: '   '
  });
  assert.equal(claude.modelName, 'claude-sonnet-4-6');

  const openai = await loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: '   '
  });
  assert.equal(openai.modelName, 'gpt-5.4-nano');
});

test('index sends successful command error replies and swallows metric failures', async () => {
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
  assert.equal(commandReplyMetrics, 2);

  delete require.cache[indexPath];
});

test('index swallows context menu reply metric failures', async () => {
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
  assert.equal(contextReplyMetrics, 2);

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
  assert.equal(commandStatusCodeMetrics, 1);

  delete require.cache[indexPath];
});

test('deploy-commands records failures using statusCode and swallows metric errors', async () => {
  let deployMetrics = 0;
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

  process.env.DISCORD_CLIENT_ID = 'client-1';
  delete require.cache[deployPath];
  const deploy = require(deployPath);
  await assert.rejects(async () => deploy());
  assert.equal(deployMetrics, 2);

  delete require.cache[deployPath];
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
  const deployHttp = require(deployPath);
  await assert.rejects(async () => deployHttp());
});

test('reset handles missing guild metadata and all-channel error scope', async () => {
  delete require.cache[resetPath];
  const command = require(resetPath);

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

  await assert.doesNotReject(async () => command.execute(interaction));

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

  await assert.doesNotReject(async () => command.execute(errorInteraction));
});

test('logger uses default log level and forwards string-only messages to Sentry', () => {
  delete require.cache[loggerPath];
  delete require.cache[pinoPath];
  delete require.cache[configPath];

  stubModule(configPath, { logLevel: undefined });
  const sentryCalls = [];
  stubModule(instrumentPath, {
    Sentry: {
      logger: {
        info: message => sentryCalls.push(message)
      },
      captureException: () => {}
    }
  });

  require.cache[pinoPath] = {
    id: pinoPath,
    filename: pinoPath,
    loaded: true,
    exports: Object.assign(
      opts => ({ child: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} }) }),
      { stdTimeFunctions: { isoTime: () => new Date().toISOString() } }
    )
  };

  const getLogger = require(loggerPath);
  const logger = getLogger('coverage-default-level');
  logger.info('plain message');
  assert.deepEqual(sentryCalls, ['plain message.']);
});

test('instrument records metrics without attributes', () => {
  delete require.cache[instrumentPath];
  const instrument = require(instrumentPath);
  const metricCalls = [];
  const original = {
    isEnabled: instrument.Sentry.isEnabled,
    metrics: instrument.Sentry.metrics
  };

  instrument.Sentry.isEnabled = () => true;
  instrument.Sentry.metrics = {
    count: (...args) => metricCalls.push(['count', ...args]),
    gauge: (...args) => metricCalls.push(['gauge', ...args]),
    distribution: (...args) => metricCalls.push(['distribution', ...args])
  };

  try {
    instrument.recordCount('metric.no_attrs');
    instrument.recordGauge('metric.no_attrs', 1);
    instrument.recordDistribution('metric.no_attrs', 2);
    assert.equal(metricCalls.length, 3);
    assert.deepEqual(metricCalls[0][3], {});
  } finally {
    instrument.Sentry.isEnabled = original.isEnabled;
    instrument.Sentry.metrics = original.metrics;
  }
});

test('aiUtils covers remaining helper branches', () => {
  const aiUtils = require(aiUtilsPath);
  assert.equal(aiUtils.estimateTokensFromText(''), 0);
  assert.equal(aiUtils.hasImages([{ role: 'user', content: 'text only' }]), false);
  assert.deepEqual(aiUtils.createMessageContent('', [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }]), [
    { type: 'input_image', image_url: 'data:image/png;base64,AA==' }
  ]);
  assert.equal(aiUtils.trimConversationHistory([], 5).length, 0);
  assert.equal(aiUtils.trimConversationHistory(null, 5), null);
});

test('replyChainTracer uses Unknown author fallback', () => {
  delete require.cache[replyChainTracerPath];
  const tracer = require(replyChainTracerPath);
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
  assert.match(tracer.formatChainAsContext(chain), /Unknown: hello/);

  const shortChain = [
    { id: 'm1', content: 'short', author: { username: 'bob' }, attachments: { size: 0 } },
    { id: 'm2', content: 'current', author: { username: 'alice' }, attachments: { size: 0 } }
  ];
  assert.match(tracer.formatChainAsContext(shortChain), /bob: short/);
  assert.doesNotMatch(tracer.formatChainAsContext(shortChain), /\.\.\./);
});

test('Gemini cache creation failure, stale cache retry success, and Claude empty turns', async () => {
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
  assert.equal(
    await cacheFail.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }]),
    'uncached ok'
  );

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
  assert.equal(
    await retrySuccess.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }]),
    'retry ok'
  );
  assert.ok(generateCalls >= 2);

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
  assert.equal(
    await regexStale.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }]),
    'regex retry ok'
  );

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
  assert.equal(
    await retryFail.generateAIResponse([{ role: 'system', content: 'x'.repeat(9000) }, { role: 'user', content: 'hi' }]),
    ''
  );

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
  assert.equal(
    await imageOnlyGemini.generateAIResponse([
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }] }
    ]),
    'image ok'
  );

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
  assert.equal(
    await geminiAssistant.generateAIResponse([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'prior reply' },
      { role: 'user', content: 'follow up' }
    ]),
    'assistant ok'
  );

  const claudeEmpty = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = { create: async () => ({ content: [{ type: 'text', text: 'should not run' }] }) };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  assert.equal(await claudeEmpty.generateAIResponse([{ role: 'system', content: 'sys only' }]), '');

  const claudeAssistant = await loadAiService({
    anthropic: function FakeAnthropic() {
      this.messages = {
        create: async () => ({ content: [{ type: 'text', text: 'claude ok' }] })
      };
    }
  }, { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'fake' });
  assert.equal(
    await claudeAssistant.generateAIResponse([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'earlier' },
      { role: 'user', content: 'again' }
    ]),
    'claude ok'
  );
});

test('messageCreate covers cooldown failures, bot reply fetch, and fallback reply metrics', async () => {
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
  assert.equal(fallbackMetrics, 2);

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
  assert.equal(editThinkingMetrics, 2);

  const thinkingFailMod = loadMessageCreate();
  await thinkingFailMod.execute(createMessage({
    reply: async payload => {
      if (payload.content === '*Thinking...*') throw new Error('thinking failed');
      return { edit: async () => {} };
    }
  }));
});

test('downloadImageAsBase64 rejects unknown mime types without content-type header', async () => {
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
    await assert.rejects(
      async () => aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png'),
      /Unsupported content-type/
    );
  } finally {
    https.get = originalGet;
  }
});

test('messageCreate initializes missing client state maps', async () => {
  const mod = loadMessageCreate();
  const bareClient = {
    user: { id: 'bot-123' },
    conversationHistory: new Map()
  };
  await mod.execute(createMessage({ client: bareClient }));
  assert.ok(bareClient.channelLocks instanceof Map);
  assert.ok(bareClient.channelQueueDepth instanceof Map);
  assert.ok(bareClient.userCooldowns instanceof Map);
  assert.ok(bareClient.channelCooldowns instanceof Map);
});

test('messageCreate ignores bot authors and prefetch fetch failures', async () => {
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
  assert.equal(replied, false);
});

test('messageCreate handles reply trigger and additional chunk rate limit metrics', async () => {
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
  assert.equal(chunkMetrics, 2);
});

test('index covers interaction handler guard branches and httpStatus fallbacks', async () => {
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

  delete require.cache[configPath];
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
  assert.equal(contextBlockedReply, true);

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

  delete require.cache[indexPath];
});

test('config resolves claude model from CLAUDE_MODEL_NAME', async () => {
  const config = await loadConfig({
    AI_PROVIDER: 'claude',
    CLAUDE_MODEL_NAME: 'claude-sonnet-4-6',
    OPENAI_MODEL_NAME: undefined
  });
  assert.equal(config.modelName, 'claude-sonnet-4-6');
});

test('reset initializes missing channelLocks on the client', async () => {
  delete require.cache[resetPath];
  delete require.cache[require.resolve('discord.js')];
  const command = require(resetPath);
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

  await assert.doesNotReject(async () => command.execute(interaction));
  assert.ok(interaction.client.channelLocks instanceof Map);
});

test('OpenAI and Claude branch coverage for optional request fields', async () => {
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
    startSpan: async (_opts, cb) => cb()
  });

  stubModule(configPath, {
    openaiApiKey: 'fake',
    geminiApiKey: 'fake',
    anthropicApiKey: 'fake',
    modelName: 'gpt-5.4-nano',
    getTemperature: () => 1,
    reasoningEffort: 42,
    responsesVerbosity: null,
    aiProvider: 'openai',
    enableWebSearch: false,
    enableGoogleMaps: false,
    enableContextCache: false,
    geminiCacheTtlSeconds: 3600,
    geminiSafetySettings: undefined,
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
            id: 'r1',
            usage: { total_tokens: 1 }
          })
        };
      }
    }
  });

  const openaiService = require(aiServicePath);
  assert.match(
    await openaiService.generateAIResponse([{ role: 'user', content: 'hi' }]),
    /couldn't generate a response/
  );

  delete require.cache[aiServicePath];
  delete require.cache[configPath];
  stubModule(configPath, {
    openaiApiKey: 'fake',
    anthropicApiKey: 'fake',
    modelName: 'claude-sonnet-4-5',
    getTemperature: () => 1,
    reasoningEffort: 'none',
    responsesVerbosity: 'low',
    aiProvider: 'claude',
    enableWebSearch: false,
    enableGoogleMaps: false,
    enableContextCache: false,
    geminiCacheTtlSeconds: 3600,
    geminiSafetySettings: undefined,
    maxOutputTokens: 1024,
    claudeThinkingBudgetTokens: 0,
    openaiTimeoutMs: 60000,
    openaiMaxRetries: 2
  });

  let round = 0;
  stubModule(require.resolve('@anthropic-ai/sdk'), function FakeAnthropic() {
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
  });

  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    closeSentry: async () => {},
    recordCount: () => {},
    recordGauge: () => {},
    recordDistribution: () => {},
    startSpan: async (_opts, cb) => cb()
  });

  const claudeService = require(aiServicePath);
  assert.equal(
    await claudeService.generateAIResponse([{ role: 'user', content: 'hi' }]),
    'final after max rounds'
  );
});

test('Gemini maps-only grounding and invalid image data URLs', async () => {
  const mapsOnly = await loadAiService({
    genai: {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: async ({ config }) => {
              assert.deepEqual(config.tools, [{ googleMaps: {} }]);
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
  assert.equal(await mapsOnly.generateAIResponse([{ role: 'user', content: 'where' }]), 'maps ok');

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
  assert.equal(
    await invalidImage.generateAIResponse([
      { role: 'user', content: [{ type: 'input_image', image_url: 'not-a-data-url' }] }
    ]),
    ''
  );
});

test('aiUtils covers attachment and token helper branches', async () => {
  const aiUtils = require(aiUtilsPath);
  assert.deepEqual(await aiUtils.processImageAttachments(null), []);
  assert.deepEqual(
    await aiUtils.processImageAttachments([{ contentType: 'text/plain', url: 'https://cdn.discordapp.com/x.txt' }]),
    []
  );

  const processed = await aiUtils.processImageAttachments([
    { contentType: 'image/png', url: 'https://cdn.discordapp.com/a.png', name: 'named.png' }
  ]);
  assert.equal(processed.length, 0);

  assert.equal(aiUtils.trimConversationHistory([{ role: 'system', content: 'sys' }], 0, 0).length, 1);

  const tokenHistory = [{ role: 'system', content: 'sys' }, { role: 'user', content: 123 }];
  aiUtils.trimConversationHistory(tokenHistory, 10, 5000);
  assert.equal(tokenHistory.length, 2);

  delete require.cache[require.resolve('../utils/aiUtils.js')];
  delete require.cache[require.resolve('../config.js')];
  stubModule(require.resolve('../config.js'), {
    imageDownloadTimeoutMs: 0,
    maxImageBytes: 0,
    maxOutputTokens: 1024
  });
  const utilsWithLimits = require(require.resolve('../utils/aiUtils.js'));
  assert.equal((await utilsWithLimits.processImageAttachments([
    { contentType: 'image/png', filename: 'pic.png', url: 'https://cdn.discordapp.com/not-real.png' }
  ])).length, 0);
  delete require.cache[require.resolve('../utils/aiUtils.js')];
  delete require.cache[require.resolve('../config.js')];
});

test('replyChainTracer returns partial chains and empty message metadata', async () => {
  delete require.cache[replyChainTracerPath];
  const tracer = require(replyChainTracerPath);

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
  assert.deepEqual(partial.map(m => m.id), ['parent', 'start']);

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
  assert.deepEqual(recovered.map(m => m.id), ['solo']);

  const rows = await tracer.extractChainMessages([
    {
      id: 'm1',
      content: '',
      author: { id: 'u1', username: 'alice', tag: 'alice#1', bot: false },
      attachments: { size: 0 },
      createdTimestamp: 1
    }
  ]);
  assert.equal(rows[0].content, '');
});

test('messageCreate branch coverage for channel name, triggers, and reply paths', async () => {
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
  assert.equal(chunkStatusCodeMetrics, 1);
});

test('index covers remaining reply error and rejection branches', async () => {
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
  assert.equal(contextHttpMetrics, 1);
  delete require.cache[indexPath];
});

test('reset logs when error-path followUp succeeds after editReply fails', async () => {
  delete require.cache[resetPath];
  delete require.cache[require.resolve('discord.js')];
  const command = require(resetPath);
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
  assert.equal(calls.length, 1);
});

test('config and aiUtils cover remaining model and download branches', async () => {
  const geminiOpenaiOnly = await loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: undefined,
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview'
  });
  assert.equal(geminiOpenaiOnly.modelName, 'gemini-3-flash-preview');

  const aiUtilsLocal = require(aiUtilsPath);
  assert.equal((await aiUtilsLocal.processImageAttachments(null)).length, 0);
});

test('replyChainTracer handles empty content in context formatting', () => {
  delete require.cache[replyChainTracerPath];
  const tracer = require(replyChainTracerPath);
  const chain = [
    { id: 'm1', content: null, author: { username: 'bob' }, attachments: { size: 0 } },
    { id: 'm2', content: 'current', author: { username: 'alice' }, attachments: { size: 0 } }
  ];
  assert.match(tracer.formatChainAsContext(chain), /bob:/);
});

test('deploy-commands records rate limit metrics and swallows metric failures', async () => {
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
  await assert.rejects(async () => deploy());
});


test('index context menu reply failures record rate limits and metric errors', async () => {
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
  delete require.cache[indexPath];
});


test('messageCreate covers thinking failures, chain tracing, and chain images', async () => {
  const discordPath = require.resolve('discord.js');
  delete require.cache[messageCreatePath];
  delete require.cache[replyChainTracerPath];
  delete require.cache[aiServicePath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];
  delete require.cache[aiUtilsPath];
  delete require.cache[discordPath];

  const discord = require(discordPath);
  stubModule(discordPath, {
    ...discord,
    Events: { ...discord.Events, MessageCreate: 'messageCreate' }
  });

  stubModule(configPath, {
    maxHistoryLength: 20,
    maxHistoryTokens: 0,
    modelName: 'gpt-5.4-nano',
    aiProvider: 'openai',
    userCooldownMs: 0,
    channelCooldownMs: 0,
    maxPendingPerChannel: 3,
    allowedGuildIds: new Set()
  });
  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    recordCount: () => {},
    recordDistribution: () => {},
    recordGauge: () => {},
    startSpan: async (_opts, cb) => cb()
  });
  stubModule(aiServicePath, { generateAIResponse: async () => 'chain ok' });
  const aiUtils = require(aiUtilsPath);
  stubModule(replyChainTracerPath, {
    traceReplyChain: async (msg, channel) => {
      if (msg.id === 'trace-fail') throw new Error('trace failed');
      return [parentWithImage, msg];
    },
    formatChainAsContext: () => '',
    extractChainMessages: async () => []
  });
  stubModule(aiUtilsPath, {
    ...aiUtils,
    processImageAttachments: async () => [{ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }],
    splitMessage: text => [text],
    createMessageContent: (text, images) => [{ type: 'input_text', text }, ...images],
    trimConversationHistory: history => history,
    createSystemMessage: () => ({ role: 'system', content: 'system' }),
    SYSTEM_MESSAGES: {
      IMAGE_ANALYSIS: 'image',
      BASE: () => 'system',
      BASE_GENERIC: 'system',
      IMAGE_DESCRIPTION_PROMPT: 'describe'
    }
  });

  const mod = require(messageCreatePath);
  const parentWithImage = {
    id: 'parent',
    author: { id: 'user-2', username: 'bob', bot: false },
    content: 'prior',
    reference: null,
    attachments: { size: 1, values: () => [{ url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png' }] }
  };

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
  assert.ok(client.conversationHistory.has('chan-1'));
  delete require.cache[aiUtilsPath];
  delete require.cache[messageCreatePath];
});


test('aiService and aiUtils remaining branches', async () => {
  delete require.cache[aiUtilsPath];
  const aiUtils = require(aiUtilsPath);
  assert.throws(() => aiUtils.assertDiscordImageDownloadUrl('http://cdn.discordapp.com/a.png'), /HTTPS/);

  delete require.cache[aiServicePath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];

  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    recordCount: () => {},
    recordDistribution: () => {},
    startSpan: async (_opts, cb) => cb(),
    closeSentry: async () => {}
  });

  stubModule(require.resolve('openai'), {
    OpenAI: class {
      constructor() {
        this.responses = {
          create: async () => ({ status: 'incomplete', output_text: '   ', id: 'r1' })
        };
      }
    }
  });

  stubModule(require.resolve('@anthropic-ai/sdk'), function FakeAnthropic() {
    this.messages = {
      create: async () => ({ content: [{ type: 'text', text: 'ok' }] })
    };
  });

  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'fake';
  const openaiService = require(aiServicePath);
  assert.equal(await openaiService.generateAIResponse([
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }] }
  ]), '');

  delete require.cache[require.resolve('../utils/aiUtils.js')];
  stubModule(require.resolve('../utils/aiUtils.js'), {
    hasImages: () => { throw new Error('hasImages failed'); },
    SYSTEM_MESSAGES: { IMAGE_ANALYSIS: 'image analysis' }
  });
  delete require.cache[aiServicePath];
  const throwingService = require(aiServicePath);
  assert.equal(await throwingService.generateAIResponse([{ role: 'user', content: 'hi' }]), '');

  delete require.cache[require.resolve('../utils/aiUtils.js')];
  delete require.cache[aiServicePath];
  delete require.cache[configPath];
  process.env.AI_PROVIDER = 'claude';
  process.env.ANTHROPIC_API_KEY = 'fake';
  const claudeService = require(aiServicePath);
  assert.equal(await claudeService.generateAIResponse([
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }] }
  ]), 'ok');

  delete require.cache[configPath];
  const config = (() => {
    process.env.AI_PROVIDER = 'gemini';
    process.env.GEMINI_MODEL_NAME = 'gemini-3-flash-preview';
    delete process.env.OPENAI_MODEL_NAME;
    delete require.cache[configPath];
    return require(configPath);
  })();
  assert.equal(config.modelName, 'gemini-3-flash-preview');
});
