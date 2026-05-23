const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

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
    recordCount: options.recordCount || (() => {}),
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
      this.user = { id: 'bot-123', tag: 'Bot#0001' };
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

  let capturedCacheLimits;
  stubModule(discordPath, {
    Client: FakeClient,
    Collection: FakeCollection,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
    Options: {
      cacheWithLimits: limits => {
        capturedCacheLimits = limits;
        return limits;
      },
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
    capturedCacheLimits,
    processHandlers: capturedProcessHandlers,
    restore: () => {
      require('fs').readdirSync = originalReaddirSync;
      process.on = originalProcessOn;
    }
  };
}

test('index cache limits keep only the bot user over limit', () => {
  const { capturedCacheLimits, restore } = loadIndexHarness();
  try {
    const memberKeep = capturedCacheLimits.GuildMemberManager.keepOverLimit;
    const userKeep = capturedCacheLimits.UserManager.keepOverLimit;
    assert.equal(memberKeep({ id: 'bot-123' }), true);
    assert.equal(memberKeep({ id: 'other' }), false);
    assert.equal(userKeep({ id: 'bot-123' }), true);
    assert.equal(userKeep({ id: 'other' }), false);
  } finally {
    restore();
  }
});

test('index wires command and signal handlers (coverage merged)', async () => {
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');

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
    client.commands.set('ctx-error-reply', { execute: async () => { throw new Error('ctx failed'); } });
    const contextHandlers = client.handlers.get('interactionCreate') || [];
    await contextHandlers[1](
      {
        isChatInputCommand: () => false,
        isContextMenuCommand: () => true,
        commandName: 'ctx-error-reply',
        user: { id: 'user-1', tag: 'User#0001' },
        guildId: 'guild-1',
        inGuild: () => true,
        replied: false,
        deferred: false,
        reply: async () => {},
        followUp: async () => {}
      }
    );

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

test('index ignores non-guild interactions when allowlist is configured', async () => {
  const { client, restore } = loadIndexHarness({ allowedGuildIds: new Set(['allowed-guild']) });
  try {
    client.commands.set('ok', { execute: async () => {} });
    const chatHandlers = client.handlers.get('interactionCreate') || [];
    await chatHandlers[0]({
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      commandName: 'ok',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: null,
      inGuild: () => false,
      replied: false,
      deferred: false,
      reply: async () => { throw new Error('should not reply'); },
      followUp: async () => {}
    });
  } finally {
    restore();
  }
});

test('index blocks interactions outside allowed guilds', async () => {
  const { client, restore } = loadIndexHarness({ allowedGuildIds: new Set(['allowed-guild']) });
  try {
    client.commands.set('ok', { execute: async () => {} });
    let replied = false;
    const chatHandlers = client.handlers.get('interactionCreate') || [];
    await chatHandlers[0]({
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      commandName: 'ok',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: 'blocked-guild',
      inGuild: () => true,
      replied: false,
      deferred: false,
      reply: async () => { replied = true; },
      followUp: async () => {}
    });
    assert.equal(replied, true);

    let ignored = false;
    await chatHandlers[0]({
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      commandName: 'ok',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: 'blocked-guild',
      inGuild: () => true,
      replied: false,
      deferred: false,
      reply: async () => { ignored = true; throw new Error('reply blocked'); },
      followUp: async () => {}
    });
    assert.equal(ignored, true);
  } finally {
    restore();
  }
});

test('index blocks context menu interactions outside allowed guilds', async () => {
  const { client, restore } = loadIndexHarness({ allowedGuildIds: new Set(['allowed-guild']) });
  try {
    client.commands.set('ctx-ok', { execute: async () => {} });
    let replied = false;
    const contextHandlers = client.handlers.get('interactionCreate') || [];
    await contextHandlers[1]({
      isChatInputCommand: () => false,
      isContextMenuCommand: () => true,
      commandName: 'ctx-ok',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: 'blocked-guild',
      inGuild: () => true,
      replied: false,
      deferred: false,
      reply: async () => { replied = true; },
      followUp: async () => {}
    });
    assert.equal(replied, true);

    let replyFailed = false;
    await contextHandlers[1]({
      isChatInputCommand: () => false,
      isContextMenuCommand: () => true,
      commandName: 'ctx-ok',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: 'blocked-guild-2',
      inGuild: () => true,
      replied: false,
      deferred: false,
      reply: async () => { replyFailed = true; throw new Error('blocked'); },
      followUp: async () => {}
    });
    assert.equal(replyFailed, true);
  } finally {
    restore();
  }
});

test('index records command reply failures using httpStatus only', async () => {
  let commandReplyMetrics = 0;
  const { client, restore } = loadIndexHarness({}, {}, {
    recordCount: (_name, _value, attrs) => {
      if (attrs?.location === 'index.command_reply') commandReplyMetrics += 1;
    }
  });
  try {
    client.commands.set('cmd-boom', { execute: async () => { throw new Error('cmd failed'); } });
    const chatHandlers = client.handlers.get('interactionCreate') || [];
    await chatHandlers[0]({
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      commandName: 'cmd-boom',
      user: { id: 'user-1', tag: 'User#0001' },
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
    assert.equal(commandReplyMetrics, 1);
  } finally {
    restore();
  }
});

test('index ignores unknown chat commands and context menu commands', async () => {
  const { client, restore } = loadIndexHarness();
  try {
    const chatHandlers = client.handlers.get('interactionCreate') || [];
    await chatHandlers[0]({
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      commandName: 'missing',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: 'guild-1',
      inGuild: () => true,
      reply: async () => { throw new Error('should not reply'); },
      followUp: async () => {}
    });

    await chatHandlers[1]({
      isChatInputCommand: () => false,
      isContextMenuCommand: () => true,
      commandName: 'missing-context',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: 'guild-1',
      inGuild: () => true,
      reply: async () => { throw new Error('should not reply'); },
      followUp: async () => {}
    });
  } finally {
    restore();
  }
});

test('index records chat command reply failures and metric errors', async () => {
  let commandReplyMetrics = 0;
  delete require.cache[indexPath];
  delete require.cache[configPath];
  delete require.cache[instrumentPath];

  stubModule(configPath, {
    token: 'fake',
    allowedGuildIds: new Set(),
    logLevel: 'info'
  });
  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    closeSentry: async () => {},
    recordCount: (name, value, attrs) => {
      if (attrs?.location === 'index.command_reply') {
        commandReplyMetrics += 1;
        if (commandReplyMetrics >= 2) throw new Error('metric failed');
      }
    },
    recordGauge: () => {},
    recordDistribution: () => {},
    startSpan: async (_opts, cb) => cb()
  });

  const { client, restore } = loadIndexHarness();
  try {
    client.commands.set('cmd-boom', { execute: async () => { throw new Error('cmd failed'); } });
    const chatHandlers = client.handlers.get('interactionCreate') || [];
    await chatHandlers[0]({
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      commandName: 'cmd-boom',
      user: { id: 'user-1', tag: 'User#0001' },
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
  } finally {
    restore();
  }
});

test('index handles successful and failing context menu commands', async () => {
  const { client, restore } = loadIndexHarness();
  try {
    client.commands.set('ctx-ok', { execute: async () => {} });
    client.commands.set('ctx-boom', { execute: async () => { throw new Error('ctx failed'); } });
    const contextHandlers = client.handlers.get('interactionCreate') || [];

    await contextHandlers[1]({
      isChatInputCommand: () => false,
      isContextMenuCommand: () => true,
      commandName: 'ctx-ok',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: 'guild-1',
      inGuild: () => true,
      replied: false,
      deferred: false,
      reply: async () => {},
      followUp: async () => {}
    });

    await contextHandlers[1]({
      isChatInputCommand: () => false,
      isContextMenuCommand: () => true,
      commandName: 'ctx-boom',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: 'guild-1',
      inGuild: () => true,
      replied: false,
      deferred: false,
      reply: async () => {
        const error = new Error('reply failed');
        error.status = 500;
        throw error;
      },
      followUp: async () => {}
    });
  } finally {
    restore();
  }
});

test('index handles context menu errors and login failures', async () => {
  const { client, restore } = loadIndexHarness({}, {}, { loginReject: true });
  try {
    client.commands.set('ctx-boom', { execute: async () => { throw new Error('ctx failed'); } });
    const contextHandlers = client.handlers.get('interactionCreate') || [];
    await contextHandlers[1]({
      isChatInputCommand: () => false,
      isContextMenuCommand: () => true,
      commandName: 'ctx-boom',
      user: { id: 'user-1', tag: 'User#0001' },
      guildId: 'guild-1',
      inGuild: () => true,
      replied: true,
      deferred: false,
      reply: async () => {
        const error = new Error('rate limited');
        error.status = 429;
        throw error;
      },
      followUp: async () => {}
    });
  } finally {
    restore();
  }
});

test('index registers process handlers and handles shutdown failures', async () => {
  delete require.cache[instrumentPath];
  stubModule(instrumentPath, {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    closeSentry: async () => { throw new Error('close failed'); },
    recordCount: () => {},
    recordGauge: () => {},
    recordDistribution: () => {},
    startSpan: async (_options, callback) => callback()
  });

  const { processHandlers, restore } = loadIndexHarness({}, {}, { captureProcessHandlers: true });
  const originalExit = process.exit;
  const exitCodes = [];
  process.exit = code => exitCodes.push(code);

  try {
    processHandlers.uncaughtException(new Error('fatal'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(exitCodes, [1]);

    processHandlers.unhandledRejection(new Error('rejection reason'), Promise.resolve());
    processHandlers.unhandledRejection('string reason', Promise.resolve());
    processHandlers.SIGINT();
    processHandlers.SIGTERM();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(exitCodes, [1, 0, 0]);
  } finally {
    process.exit = originalExit;
    restore();
    delete require.cache[instrumentPath];
  }
});

test('index logs command and event load failures and event handler errors', async () => {
  const commandsDir = path.join(__dirname, '..', 'commands');
  const eventsDir = path.join(__dirname, '..', 'events');
  const onceEventPath = path.join(eventsDir, 'once-fail-event.js');
  const repeatEventPath = path.join(eventsDir, 'repeat-fail-event.js');
  const badCommandPath = path.join(commandsDir, 'bad-command.js');

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === badCommandPath || request.endsWith(`${path.sep}bad-command.js`)) {
      throw new Error('bad command load');
    }
    if (request === onceEventPath || request.endsWith(`${path.sep}once-fail-event.js`)) {
      const exports = {
        name: 'onceFail',
        once: true,
        execute: async () => {
          throw new Error('once event failed');
        }
      };
      require.cache[request] = { id: request, filename: request, loaded: true, exports };
      return exports;
    }
    if (request === repeatEventPath || request.endsWith(`${path.sep}repeat-fail-event.js`)) {
      const exports = {
        name: 'repeatFail',
        once: false,
        execute: async () => {
          throw new Error('repeat event failed');
        }
      };
      require.cache[request] = { id: request, filename: request, loaded: true, exports };
      return exports;
    }
    return originalLoad.apply(this, arguments);
  };

  const { client, restore } = loadIndexHarness(
    {},
    { commands: ['bad-command.js'], events: ['missing-event.js', 'once-fail-event.js', 'repeat-fail-event.js'] }
  );

  try {
    await new Promise(resolve => setImmediate(resolve));
    const onceHandlers = client.handlers.get('onceFail') || [];
    const repeatHandlers = client.handlers.get('repeatFail') || [];
    assert.equal(onceHandlers.length, 1);
    assert.equal(repeatHandlers.length, 1);
    await onceHandlers[0]({ user: { tag: 'Bot#1' } });
    await repeatHandlers[0]();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    Module._load = originalLoad;
    restore();
  }
});
