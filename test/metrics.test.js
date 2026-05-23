const path = require('path');
const { stubModule, reloadModule } = require('./testUtils.cjs');

const messageCreatePath = path.resolve(__dirname, '..', 'events', 'messageCreate.js');
const deployPath = path.resolve(__dirname, '..', 'deploy-commands.js');
const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');

function stubInstrument(calls, instrumentStub) {
  stubModule(instrumentPath, instrumentStub);
  return { calls, instPath: instrumentPath };
}

test('should records rate limit metric when edit fails with 429', async () => {
  const calls = [];
  const msgModule = reloadModule(messageCreatePath, () => {
    const baseConfig = require(configPath);
    stubModule(configPath, {
      ...baseConfig,
      userCooldownMs: 0,
      channelCooldownMs: 0,
      allowedGuildIds: new Set()
    });
    stubModule(aiServicePath, { generateAIResponse: async () => 'ok' });
    stubInstrument(calls, {
      Sentry: { isEnabled: () => false },
      captureError: (err, tags) => calls.push({ fn: 'captureError', err, tags }),
      recordCount: (name, value, attrs) => calls.push({ fn: 'recordCount', name, value, attrs }),
      recordDistribution: (name, value, opts) => calls.push({ fn: 'recordDistribution', name, value, opts }),
      recordGauge: (name, value, attrs) => calls.push({ fn: 'recordGauge', name, value, attrs }),
      startSpan: async (opts, cb) => {
        if (typeof cb === 'function') return cb();
        return null;
      },
      closeSentry: async () => {}
    });
  });

  const messageReplies = [];
  const message = {
    id: 'm1',
    content: '<@123> hi',
    channelId: 'chan-1',
    channel: { name: 'general', messages: { fetch: async () => ({ author: { id: 'bot-123' }, content: 'prev' }) } },
    client: {
      user: { id: 'bot-123' },
      channelLocks: new Map(),
      channelQueueDepth: new Map(),
      userCooldowns: new Map(),
      channelCooldowns: new Map(),
      conversationHistory: new Map()
    },
    author: { bot: false, id: 'user-1', tag: 'User#1' },
    mentions: { has: () => true, users: { has: () => true } },
    reference: null,
    attachments: new Map(),
    reply: async (payload) => {
      if (messageReplies.length === 0) {
        messageReplies.push(payload.content);
        return { edit: async () => { throw Object.assign(new Error('cannot edit'), { status: 429 }); } };
      }
      messageReplies.push(payload.content);
      return { edit: async () => {} };
    }
  };

  await msgModule.execute(message);

  const rateLimitCalls = calls.filter(c => c.fn === 'recordCount' && c.name === 'discord.api.rate_limit');
  expect(rateLimitCalls.length).toBeGreaterThanOrEqual(1);
  const locations = rateLimitCalls.map(c => c.attrs?.location || c.attrs?.location);
  expect(locations.some(l => l && l.includes('messageCreate.edit_thinking'))).toBe(true);
});

test('should records failure metric when registration fails', async () => {
  const calls = [];
  process.env.DISCORD_CLIENT_ID = 'client-1';
  global.__discordStub = {
    SlashCommandBuilder: class { constructor(){ this._data = {}; } setName(){ return this; } setDescription(){ return this; } setDefaultMemberPermissions(){ return this; } addChannelOption(){ return this; } toJSON(){ return this._data; } },
    EmbedBuilder: class { constructor(){ this._e = {}; } setColor(){ return this; } setTitle(){ return this; } setDescription(){ return this; } },
    ChannelType: { GuildText: 0 },
    PermissionFlagsBits: { Administrator: 0 },
    REST: class { setToken() { return this; } async put() { const e = new Error('fail'); e.status = 500; throw e; } },
    Routes: { applicationCommands: (id) => `/apps/${id}/cmds` }
  };
  const deploy = reloadModule(deployPath, () => {
    stubInstrument(calls, {
      Sentry: { isEnabled: () => false },
      captureError: (err, tags) => calls.push({ fn: 'captureError', err, tags }),
      recordCount: (name, value, attrs) => calls.push({ fn: 'recordCount', name, value, attrs }),
      recordDistribution: (name, value, opts) => calls.push({ fn: 'recordDistribution', name, value, opts }),
      recordGauge: (name, value, attrs) => calls.push({ fn: 'recordGauge', name, value, attrs }),
      startSpan: async (opts, cb) => {
        if (typeof cb === 'function') return cb();
        return null;
      },
      closeSentry: async () => {}
    });
  });

  await expect(deploy()).rejects.toThrow();

  const failureCalls = calls.filter(c => c.fn === 'recordCount' && c.name === 'discord.api.failure');
  expect(failureCalls.length).toBeGreaterThanOrEqual(1);
});

test('should swallows metric recording failures on deploy error', async () => {
  let recordCountCalls = 0;

  process.env.DISCORD_CLIENT_ID = 'client-1';
  global.__discordStub = {
    SlashCommandBuilder: class { constructor() {} setName() { return this; } setDescription() { return this; } setDefaultMemberPermissions() { return this; } addChannelOption() { return this; } toJSON() { return {}; } },
    EmbedBuilder: class { setColor() { return this; } setTitle() { return this; } setDescription() { return this; } },
    ChannelType: { GuildText: 0 },
    PermissionFlagsBits: { Administrator: 0 },
    REST: class { setToken() { return this; } async put() { const e = new Error('rate limited'); e.status = 429; throw e; } },
    Routes: { applicationCommands: id => `/apps/${id}/cmds` }
  };
  const deploy = reloadModule(deployPath, () => {
    stubModule(instrumentPath, {
      Sentry: { isEnabled: () => false },
      captureError: () => {},
      recordCount: () => {
        recordCountCalls += 1;
        if (recordCountCalls > 1) {
          throw new Error('metric failed');
        }
      },
      recordDistribution: () => {},
      startSpan: async (_opts, cb) => cb(),
      closeSentry: async () => {}
    });
  });

  await expect(deploy()).rejects.toThrow();
  expect(recordCountCalls).toBeGreaterThanOrEqual(2);
});
