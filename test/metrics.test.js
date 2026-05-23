const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Utility to stub the instrument module before loading other modules
function stubInstrument() {
  const instPath = path.resolve(__dirname, '..', 'instrument.js');
  const calls = [];
  const stub = {
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
  };

  require.cache[instPath] = {
    id: instPath,
    filename: instPath,
    loaded: true,
    exports: stub
  };

  return { calls, instPath };
}

test('messageCreate records rate limit metric when edit fails with 429', async () => {
  const { calls } = stubInstrument();

  // Stub aiService.generateAIResponse
  const aiPath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
  require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: { generateAIResponse: async () => 'ok' } };

  // Load messageCreate
  delete require.cache[path.resolve(__dirname, '..', 'events', 'messageCreate.js')];
  const msgModule = require(path.resolve(__dirname, '..', 'events', 'messageCreate.js'));

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
      // First call: thinking message
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
  assert(rateLimitCalls.length >= 1, 'expected at least one discord.api.rate_limit metric');
  const locations = rateLimitCalls.map(c => c.attrs?.location || c.attrs?.location);
  assert(locations.some(l => l && l.includes('messageCreate.edit_thinking')),
    'expected rate limit recorded for edit_thinking');
});

test('deploy-commands records failure metric when registration fails', async () => {
  const { calls } = stubInstrument();

  // Stub a minimal discord.js used by deploy-commands
  const discordPath = require.resolve('discord.js');
  const fakeDiscord = {
    // Minimal builders used by commands
    SlashCommandBuilder: class { constructor(){ this._data = {}; } setName(){ return this; } setDescription(){ return this; } setDefaultMemberPermissions(){ return this; } addChannelOption(){ return this; } toJSON(){ return this._data; } },
    EmbedBuilder: class { constructor(){ this._e = {}; } setColor(){ return this; } setTitle(){ return this; } setDescription(){ return this; } },
    ChannelType: { GuildText: 0 },
    PermissionFlagsBits: { Administrator: 0 },
    REST: class { setToken() { return this; } async put() { const e = new Error('fail'); e.status = 500; throw e; } },
    Routes: { applicationCommands: (id) => `/apps/${id}/cmds` }
  };
  require.cache[discordPath] = { id: discordPath, filename: discordPath, loaded: true, exports: fakeDiscord };

  process.env.DISCORD_CLIENT_ID = 'client-1';
  delete require.cache[path.resolve(__dirname, '..', 'deploy-commands.js')];
  const deploy = require(path.resolve(__dirname, '..', 'deploy-commands.js'));

  await assert.rejects(async () => deploy());

  const failureCalls = calls.filter(c => c.fn === 'recordCount' && c.name === 'discord.api.failure');
  assert(failureCalls.length >= 1, 'expected discord.api.failure metric to be recorded');
});

test('deploy-commands swallows metric recording failures on deploy error', async () => {
  let recordCountCalls = 0;
  const instPath = path.resolve(__dirname, '..', 'instrument.js');
  require.cache[instPath] = {
    id: instPath,
    filename: instPath,
    loaded: true,
    exports: {
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
    }
  };

  const discordPath = require.resolve('discord.js');
  require.cache[discordPath] = {
    id: discordPath,
    filename: discordPath,
    loaded: true,
    exports: {
      SlashCommandBuilder: class { constructor() {} setName() { return this; } setDescription() { return this; } setDefaultMemberPermissions() { return this; } addChannelOption() { return this; } toJSON() { return {}; } },
      EmbedBuilder: class { setColor() { return this; } setTitle() { return this; } setDescription() { return this; } },
      ChannelType: { GuildText: 0 },
      PermissionFlagsBits: { Administrator: 0 },
      REST: class { setToken() { return this; } async put() { const e = new Error('rate limited'); e.status = 429; throw e; } },
      Routes: { applicationCommands: id => `/apps/${id}/cmds` }
    }
  };

  process.env.DISCORD_CLIENT_ID = 'client-1';
  delete require.cache[path.resolve(__dirname, '..', 'deploy-commands.js')];
  const deploy = require(path.resolve(__dirname, '..', 'deploy-commands.js'));

  await assert.rejects(async () => deploy());
  assert.equal(recordCountCalls >= 2, true);
});
