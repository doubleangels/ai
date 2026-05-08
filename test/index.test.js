const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const indexPath = path.resolve(__dirname, '..', 'index.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const discordPath = require.resolve('discord.js');
const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
const aiUtilsPath = path.resolve(__dirname, '..', 'utils', 'aiUtils.js');

function stubModule(modulePath, exportsObj) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsObj
  };
}

function loadIndexHarness(configOverrides = {}, fileLists = {}, options = {}) {
  delete require.cache[indexPath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];
  delete require.cache[aiServicePath];
  delete require.cache[aiUtilsPath];
  delete require.cache[discordPath];

  stubModule(configPath, {
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
    imageDownloadTimeoutMs: 8000,
    maxImageBytes: 6_000_000,
    openaiTimeoutMs: 60000,
    openaiMaxRetries: 2,
    getTemperature: () => 1,
    ...configOverrides
  });

  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    closeSentry: async () => {},
    recordCount: () => {},
    recordGauge: () => {},
    recordDistribution: () => {},
    startSpan: async (_options, callback) => callback()
  });

  stubModule(aiServicePath, { generateAIResponse: async () => 'index response' });
  stubModule(aiUtilsPath, {
    splitMessage: text => [text],
    processImageAttachments: async () => [],
    createMessageContent: text => [{ type: 'input_text', text }],
    trimConversationHistory: history => history,
    createSystemMessage: () => ({ role: 'system', content: 'system' }),
    SYSTEM_MESSAGES: { IMAGE_ANALYSIS: 'image', BASE: () => 'system', BASE_GENERIC: 'system' }
  });

  class FakeCollection extends Map {}
  class FakeClient {
    constructor() {
      FakeClient.instances.push(this);
      this.commands = new FakeCollection();
      this.conversationHistory = new Map();
      this.channelLocks = new Map();
      this.handlers = new Map();
      this.user = { tag: 'Bot#0001' };
      this.guilds = { cache: new Map() };
    }

    on(eventName, handler) {
      const handlers = this.handlers.get(eventName) || [];
      handlers.push(handler);
      this.handlers.set(eventName, handlers);
    }

    once(eventName, handler) {
      this.on(eventName, handler);
    }

    login() {
      return options.loginReject
        ? Promise.reject(new Error('login failed'))
        : Promise.resolve();
    }
  }
  FakeClient.instances = [];

  stubModule(discordPath, {
    Client: FakeClient,
    Collection: FakeCollection,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
    Options: {
      cacheWithLimits: () => ({}),
      DefaultMakeCacheSettings: {}
    },
    SlashCommandBuilder: class {
      constructor() {
        this.name = '';
      }

      setName(value) { this.name = value; return this; }
      setDescription() { return this; }
      setDefaultMemberPermissions() { return this; }
      addChannelOption(callback) {
        callback({ setName() { return this; }, setDescription() { return this; }, addChannelTypes() { return this; }, setRequired() { return this; } });
        return this;
      }
      toJSON() { return { name: this.name }; }
    },
    EmbedBuilder: class {
      constructor() { this.data = {}; }
      setColor(value) { this.data.color = value; return this; }
      setTitle(value) { this.data.title = value; return this; }
      setDescription(value) { this.data.description = value; return this; }
    },
    ChannelType: { GuildText: 0 },
    PermissionFlagsBits: { Administrator: 1 },
    Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' },
    ActivityType: { Watching: 'Watching' }
  });

  const originalReaddirSync = require('fs').readdirSync;
  const originalProcessOn = process.on;
  const capturedProcessHandlers = {};
  if (options.captureProcessHandlers) {
    process.on = (eventName, handler) => {
      capturedProcessHandlers[eventName] = handler;
      return process;
    };
  }
  require('fs').readdirSync = directory => {
    if (directory.endsWith(path.sep + 'commands')) {
      return fileLists.commands || ['reset.js'];
    }
    if (directory.endsWith(path.sep + 'events')) {
      return fileLists.events || ['ready.js', 'messageCreate.js'];
    }
    return originalReaddirSync(directory);
  };

  require(indexPath);

  const client = FakeClient.instances[0];

  return {
    client,
    processHandlers: capturedProcessHandlers,
    restore: () => {
      require('fs').readdirSync = originalReaddirSync;
      process.on = originalProcessOn;
    }
  };
}

test('index wires command and signal handlers (coverage merged)', async () => {
  const { client, restore } = loadIndexHarness();
  const originalExit = process.exit;
  const exitCodes = [];
  process.exit = code => {
    exitCodes.push(code);
  };

  try {
    client.commands.set('ok', { execute: async () => {} });
    client.commands.set('boom', { execute: async () => { throw new Error('command failed'); } });

    const chatHandlers = client.handlers.get('interactionCreate') || [];
    assert.equal(chatHandlers.length >= 2, true);

    await chatHandlers[0](
      {
        isChatInputCommand: () => true,
        isContextMenuCommand: () => false,
        commandName: 'ok',
        user: { id: 'user-1', tag: 'User#0001' },
        guildId: 'guild-1',
        inGuild: () => true,
        replied: false,
        deferred: false,
        reply: async () => {},
        followUp: async () => {}
      }
    );

    await chatHandlers[0](
      {
        isChatInputCommand: () => true,
        isContextMenuCommand: () => false,
        commandName: 'boom',
        user: { id: 'user-1', tag: 'User#0001' },
        guildId: 'guild-1',
        inGuild: () => true,
        replied: false,
        deferred: false,
        reply: async () => {
          const error = new Error('rate limited');
          error.status = 429;
          throw error;
        },
        followUp: async () => {}
      }
    );

    await chatHandlers[0](
      {
        isChatInputCommand: () => true,
        isContextMenuCommand: () => false,
        commandName: 'boom',
        user: { id: 'user-1', tag: 'User#0001' },
        guildId: 'guild-1',
        inGuild: () => true,
        replied: true,
        deferred: false,
        reply: async () => {},
        followUp: async () => {}
      }
    );

    client.commands.set('context-ok', { execute: async () => {} });
    const contextHandlers = client.handlers.get('interactionCreate') || [];
    await contextHandlers[1](
      {
        isChatInputCommand: () => false,
        isContextMenuCommand: () => true,
        commandName: 'context-ok',
        user: { id: 'user-1', tag: 'User#0001' },
        guildId: 'guild-1',
        inGuild: () => true,
        replied: false,
        deferred: false,
        reply: async () => {},
        followUp: async () => {}
      }
    );

    process.emit('SIGINT');
    process.emit('SIGTERM');

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(exitCodes, [0, 0]);
  } finally {
    process.exit = originalExit;
    restore();
  }
});
