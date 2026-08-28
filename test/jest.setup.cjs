// Global Jest setup: stub heavy or native modules and prevent network calls during tests
const path = require('path');

function register(id, exports) {
  try {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  } catch {
    const fakePath = path.join(process.cwd(), 'node_modules', id, 'index.js');
    require.cache[fakePath] = { id: fakePath, filename: fakePath, loaded: true, exports };
  }
}

function registerCoreStubs() {
  register('discord.js', {
    Client: class { constructor() { this.on = () => {}; this.once = () => {}; } },
    Collection: class extends Map {},
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  MessageFlags: { Ephemeral: 64 },
  ActivityType: { Watching: 3 },
    Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' },
    SlashCommandBuilder: class {
      constructor() { this._data = {}; }
      setName() { return this; }
      setDescription() { return this; }
      setDefaultMemberPermissions() { return this; }
      setIntegrationTypes() { return this; }
      setContexts() { return this; }
      addStringOption(cb) {
        const option = {
          setName: () => option,
          setDescription: () => option,
          setRequired: () => option,
          setMaxLength: () => option,
          addChoices: () => option
        };
        try { cb(option); } catch (_) {}
        return this;
      }
      addAttachmentOption(cb) {
        const option = {
          setName: () => option,
          setDescription: () => option,
          setRequired: () => option
        };
        try { cb(option); } catch (_) {}
        return this;
      }
      addChannelOption(cb) {
        const option = {
          setName: () => option,
          setDescription: () => option,
          addChannelTypes: () => option,
          setRequired: () => option
        };
        try { cb(option); } catch (_) {}
        return this;
      }
      toJSON() { return this._data; }
    },
    ApplicationIntegrationType: { GuildInstall: 0, UserInstall: 1 },
    InteractionContextType: { Guild: 0, BotDM: 1, PrivateChannel: 2 },
    EmbedBuilder: class {
      constructor() { this.data = {}; }
      setColor(c) { this.data.color = c; return this; }
      setTitle(t) { this.data.title = t; return this; }
      setDescription(d) { this.data.description = d; return this; }
    },
    ChannelType: { GuildText: 0 },
    PermissionFlagsBits: { Administrator: 0 },
    REST: class { constructor() {} setToken() {} async put() { return { ok: true }; } },
    Routes: { applicationCommands: id => `/applications/${id}/commands` }
  });

  const fakePino = function () {
    const logger = {
      child: () => logger,
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {}
    };
    return logger;
  };
  fakePino.stdTimeFunctions = { isoTime: () => `,"time":"${new Date().toISOString()}"` };
  register('pino', fakePino);

  register('dotenv', { config: () => ({ parsed: {} }) });
}

function registerSentryStubs() {
  register('@sentry/node', {
    init: () => {},
    captureException: () => {},
    withScope: fn => { fn({ setTags: () => {} }); },
    getGlobalScope: () => ({ setAttributes: () => {} }),
    isEnabled: () => true,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    metrics: {
      count: () => {},
      gauge: () => {},
      distribution: () => {}
    },
    startSpan: (options, cb) => {
      if (typeof cb === 'function') return cb();
      return { finish: () => {} };
    },
    close: async () => {}
  });

  register('@sentry/profiling-node', {
    nodeProfilingIntegration: () => () => {}
  });
}

function registerDefaultStubs() {
  registerCoreStubs();
  registerSentryStubs();
}

registerDefaultStubs();

module.exports = { registerCoreStubs, registerSentryStubs, registerDefaultStubs };
