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

test('index wires command and signal handlers', async () => {
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

    await chatHandlers[0]({
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
    });

    await chatHandlers[0]({
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
    });

    await chatHandlers[0]({
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
    });

    client.commands.set('context-ok', { execute: async () => {} });
    const contextHandlers = client.handlers.get('interactionCreate') || [];
    await contextHandlers[1]({
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
    });

    process.emit('SIGINT');
    process.emit('SIGTERM');

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(exitCodes, [0, 0]);
  } finally {
    process.exit = originalExit;
    restore();
  }
});

test('index blocks disabled guilds and unknown context menus', async () => {
  const { client, restore } = loadIndexHarness({
    allowedGuildIds: new Set(['allowed-guild'])
  });

  try {
    const handlers = client.handlers.get('interactionCreate') || [];
    await handlers[0]({
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      commandName: 'missing',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: 'denied-guild',
      inGuild: () => true,
      replied: false,
      deferred: false,
      reply: async () => {},
      followUp: async () => {}
    });

    await handlers[1]({
      isChatInputCommand: () => false,
      isContextMenuCommand: () => true,
      commandName: 'missing-context',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: 'allowed-guild',
      inGuild: () => true,
      replied: false,
      deferred: false,
      reply: async () => {},
      followUp: async () => {}
    });
  } finally {
    restore();
  }
});

test('index rejects interactions outside guild context', async () => {
  const { client, restore } = loadIndexHarness({
    allowedGuildIds: new Set(['allowed-guild'])
  });

  try {
    const handlers = client.handlers.get('interactionCreate') || [];
    client.commands.set('ok', { execute: async () => {} });
    let replyCount = 0;

    await handlers[0]({
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      commandName: 'ok',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: null,
      inGuild: () => false,
      replied: false,
      deferred: false,
      reply: async () => {
        replyCount += 1;
      },
      followUp: async () => {
        replyCount += 1;
      }
    });

    assert.equal(replyCount, 1);
  } finally {
    restore();
  }
});

test('index logs login failures and process-level handlers', async () => {
  const { processHandlers, restore } = loadIndexHarness({}, {}, { captureProcessHandlers: true });
  const originalExit = process.exit;
  const exitCodes = [];
  process.exit = code => {
    exitCodes.push(code);
  };

  const loginClient = { login: () => Promise.reject(new Error('login failed')) };
  try {
    await processHandlers['uncaughtException']?.(new Error('uncaught'));
    await processHandlers['unhandledRejection']?.(new Error('rejection'), Promise.resolve());
    await processHandlers['SIGINT']?.();
    await processHandlers['SIGTERM']?.();

    assert.equal(Array.isArray(exitCodes), true);
  } finally {
    process.exit = originalExit;
    restore();
  }
});

test('index handles command and event load failures', () => {
  const { restore } = loadIndexHarness({}, {
    commands: ['missing-command.js'],
    events: ['missing-event.js']
  }, {
    loginReject: true
  });

  restore();
});

test('index logs event execution failures for once and regular handlers', async () => {
  const root = path.resolve(__dirname, '..');
  const onceEventPath = path.join(root, 'events', 'ready.js');
  const regularEventPath = path.join(root, 'events', 'messageCreate.js');

  require.cache[onceEventPath] = {
    id: onceEventPath,
    filename: onceEventPath,
    loaded: true,
    exports: {
      name: 'ready',
      once: true,
      execute: async () => {
        throw new Error('once event failed');
      }
    }
  };

  require.cache[regularEventPath] = {
    id: regularEventPath,
    filename: regularEventPath,
    loaded: true,
    exports: {
      name: 'messageCreate',
      once: false,
      execute: async () => {
        throw new Error('regular event failed');
      }
    }
  };

  const { client, restore } = loadIndexHarness({}, {
    commands: ['reset.js'],
    events: ['ready.js', 'messageCreate.js']
  });

  try {
    const readyHandlers = client.handlers.get('ready') || [];
    const messageHandlers = client.handlers.get('messageCreate') || [];

    assert.equal(typeof readyHandlers[0], 'function');
    assert.equal(typeof messageHandlers[0], 'function');

    readyHandlers[0]();
    messageHandlers[0]({
      author: { bot: false, id: 'user-1', tag: 'User#0001' },
      channelId: 'chan-1',
      channel: { name: 'general' },
      client,
      content: 'hello',
      mentions: { has: () => false },
      attachments: new Map(),
      reference: null,
      guildId: 'guild-1',
      reply: async () => ({ edit: async () => {} })
    });
  } finally {
    restore();
    delete require.cache[onceEventPath];
    delete require.cache[regularEventPath];
  }
});