// Central test preload to stub heavy or native modules and prevent network calls during tests
const Module = require('module');
const path = require('path');

function register(id, exports) {
  try {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  } catch {
    // If module not resolvable, create a synthetic path under node_modules
    const fakePath = path.join(process.cwd(), 'node_modules', id, 'index.js');
    require.cache[fakePath] = { id: fakePath, filename: fakePath, loaded: true, exports };
  }
}

// Minimal discord.js stub used by tests
register('discord.js', {
  Client: class { constructor() { this.on = () => {}; this.once = () => {}; } },
  Collection: class extends Map {},
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  ActivityType: { Watching: 3 },
  Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' },
  SlashCommandBuilder: class {
    constructor(){ this._data = {}; }
    setName(){ return this; }
    setDescription(){ return this; }
    setDefaultMemberPermissions(){ return this; }
    addChannelOption(cb){
      const option = {
        setName: () => option,
        setDescription: () => option,
        addChannelTypes: () => option,
        setRequired: () => option
      };
      try { cb(option); } catch (_) {}
      return this;
    }
    toJSON(){ return this._data; }
  },
  EmbedBuilder: class {
    constructor(){ this.data = {}; }
    setColor(c){ this.data.color = c; return this; }
    setTitle(t){ this.data.title = t; return this; }
    setDescription(d){ this.data.description = d; return this; }
  },
  ChannelType: { GuildText: 0 },
  PermissionFlagsBits: { Administrator: 0 },
  REST: class { constructor(){} setToken(){} async put(){ return { ok: true }; } },
  Routes: { applicationCommands: (id) => `/applications/${id}/commands` }
});

// Minimal pino stub
// Provide a pino-like API with stdTimeFunctions.isoTime used by logger.js
const fakePino = function (opts) {
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

// Sentry stub with metrics and spans
register('@sentry/node', {
  init: () => {},
  captureException: () => {},
  withScope: (fn) => { fn({ setTags: () => {} }); },
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

// profiling integration stub
register('@sentry/profiling-node', {
  nodeProfilingIntegration: () => () => {}
});

// Minimal OpenAI / Gemini / Claude SDK stubs to avoid MODULE_NOT_FOUND
register('openai', { OpenAIApi: class {} , Configuration: class {}});
register('@google/genai', { TextServiceClient: class {} });
register('@anthropic-ai/sdk', { Anthropic: class {} });

// Ensure dotenv is available (should be installed) — if not, provide noop
try { require.resolve('dotenv'); } catch { register('dotenv', { config: () => {} }); }

// Prevent accidental network timeouts by monkeypatching https request in test environment
try {
  const httpsPath = require.resolve('https');
  const https = require('https');
  // no-op — leave original if present
} catch {
  // ignore
}

// done
