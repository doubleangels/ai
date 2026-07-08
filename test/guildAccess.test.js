const path = require('path');
const { stubModule, reloadModule, DEFAULT_CONFIG } = require('./testUtils.cjs');

const guildAccessPath = path.resolve(__dirname, '..', 'utils', 'guildAccess.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const discordApiPath = path.resolve(__dirname, '..', 'utils', 'discordApi.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');

function loadGuildAccess(configOverrides = {}) {
  return reloadModule(guildAccessPath, () => {
    stubModule(configPath, {
      ...DEFAULT_CONFIG,
      allowedGuildIds: new Set(),
      ...configOverrides
    });
    stubModule(discordApiPath, { withDiscordRetry: fn => fn() });
    stubModule(instrumentPath, {
      captureError: () => {},
      recordCount: () => {}
    });
    stubModule(path.resolve(__dirname, '..', 'utils', 'aiUtils.js'), {
      pruneChannelAuxMaps: () => {}
    });
  });
}

test('should treat all guilds as allowed when allowlist is empty', () => {
  const { isGuildAllowlisted } = loadGuildAccess();
  expect(isGuildAllowlisted('guild-1')).toBe(true);
  expect(isGuildAllowlisted(null)).toBe(true);
});

test('should reject guilds outside allowlist', () => {
  const { isGuildAllowlisted } = loadGuildAccess({
    allowedGuildIds: new Set(['allowed-guild'])
  });
  expect(isGuildAllowlisted('allowed-guild')).toBe(true);
  expect(isGuildAllowlisted('blocked-guild')).toBe(false);
  expect(isGuildAllowlisted(null)).toBe(false);
});

test('should leave all disallowed guilds when allowlist is set', async () => {
  const { leaveDisallowedGuilds } = loadGuildAccess({
    allowedGuildIds: new Set(['allowed-guild'])
  });

  const leaveCounts = new Map([
    ['blocked-1', 0],
    ['blocked-2', 0],
    ['allowed-guild', 0]
  ]);
  const client = {
    conversationHistory: new Map(),
    channelGuildIds: new Map(),
    guilds: {
      cache: new Map([
        ['blocked-1', {
          id: 'blocked-1',
          name: 'Blocked One',
          leave: async () => { leaveCounts.set('blocked-1', leaveCounts.get('blocked-1') + 1); }
        }],
        ['blocked-2', {
          id: 'blocked-2',
          name: 'Blocked Two',
          leave: async () => { leaveCounts.set('blocked-2', leaveCounts.get('blocked-2') + 1); }
        }],
        ['allowed-guild', {
          id: 'allowed-guild',
          name: 'Allowed',
          leave: async () => { leaveCounts.set('allowed-guild', leaveCounts.get('allowed-guild') + 1); }
        }]
      ])
    }
  };

  const leftCount = await leaveDisallowedGuilds(client, 'ready');

  expect(leftCount).toBe(2);
  expect(leaveCounts.get('blocked-1')).toBe(1);
  expect(leaveCounts.get('blocked-2')).toBe(1);
  expect(leaveCounts.get('allowed-guild')).toBe(0);
});

test('should not leave any guilds when allowlist is empty', async () => {
  const { leaveDisallowedGuilds } = loadGuildAccess();

  let leaveCount = 0;
  const client = {
    guilds: {
      cache: new Map([
        ['guild-1', {
          id: 'guild-1',
          name: 'Any Guild',
          leave: async () => { leaveCount += 1; }
        }]
      ])
    }
  };

  const leftCount = await leaveDisallowedGuilds(client, 'ready');

  expect(leftCount).toBe(0);
  expect(leaveCount).toBe(0);
});

test('should log guild name when leaving disallowed guild', async () => {
  const loggerPath = path.resolve(__dirname, '..', 'logger.js');
  const infoSpy = jest.fn();
  const { leaveDisallowedGuild } = reloadModule(guildAccessPath, () => {
    stubModule(configPath, {
      ...DEFAULT_CONFIG,
      allowedGuildIds: new Set(['allowed-guild'])
    });
    stubModule(discordApiPath, { withDiscordRetry: fn => fn() });
    stubModule(instrumentPath, {
      captureError: () => {},
      recordCount: () => {}
    });
    stubModule(path.resolve(__dirname, '..', 'utils', 'aiUtils.js'), {
      pruneChannelAuxMaps: () => {}
    });
    stubModule(loggerPath, () => ({
      info: infoSpy,
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    }));
  });

  const client = {
    conversationHistory: new Map(),
    channelGuildIds: new Map()
  };
  const guild = {
    id: 'blocked-guild',
    name: 'Blocked Server',
    leave: async () => {}
  };

  await leaveDisallowedGuild(client, guild, 'test');

  expect(infoSpy).toHaveBeenCalledWith(
    'Left disallowed guild "Blocked Server".',
    expect.objectContaining({ guildId: 'blocked-guild', guildName: 'Blocked Server' })
  );
});

test('should leave disallowed guild once', async () => {
  const { leaveDisallowedGuild } = loadGuildAccess({
    allowedGuildIds: new Set(['allowed-guild'])
  });

  let leaveCount = 0;
  const client = {
    conversationHistory: new Map(),
    channelGuildIds: new Map()
  };
  const guild = {
    id: 'blocked-guild',
    name: 'Blocked',
    leave: async () => { leaveCount += 1; }
  };

  const first = await leaveDisallowedGuild(client, guild, 'test');
  const second = await leaveDisallowedGuild(client, guild, 'test');

  expect(first).toBe(true);
  expect(second).toBe(false);
  expect(leaveCount).toBe(1);
});

test('should clear conversation state for channels in the left guild', async () => {
  const prunedChannels = [];
  const { leaveDisallowedGuild } = reloadModule(guildAccessPath, () => {
    stubModule(configPath, {
      ...DEFAULT_CONFIG,
      allowedGuildIds: new Set(['allowed-guild'])
    });
    stubModule(discordApiPath, { withDiscordRetry: fn => fn() });
    stubModule(instrumentPath, {
      captureError: () => {},
      recordCount: () => {}
    });
    stubModule(path.resolve(__dirname, '..', 'utils', 'aiUtils.js'), {
      pruneChannelAuxMaps: channelId => { prunedChannels.push(channelId); }
    });
  });

  const client = {
    conversationHistory: new Map([
      ['chan-blocked', [{ role: 'user', content: 'hi' }]],
      ['chan-other', [{ role: 'user', content: 'hi' }]]
    ]),
    channelGuildIds: new Map([
      ['chan-blocked', 'blocked-guild'],
      ['chan-other', 'other-guild']
    ]),
    channelLastActivity: new Map([['chan-blocked', Date.now()]]),
    channelCooldowns: new Map([['chan-blocked', Date.now()]]),
    channelLocks: new Map(),
    channelQueueDepth: new Map()
  };
  const guild = {
    id: 'blocked-guild',
    name: 'Blocked',
    leave: async () => {}
  };

  const left = await leaveDisallowedGuild(client, guild, 'test');

  expect(left).toBe(true);
  expect(client.conversationHistory.has('chan-blocked')).toBe(false);
  expect(client.conversationHistory.has('chan-other')).toBe(true);
  expect(client.channelLastActivity.has('chan-blocked')).toBe(false);
  expect(client.channelCooldowns.has('chan-blocked')).toBe(false);
  expect(client.channelGuildIds.has('chan-blocked')).toBe(false);
  expect(prunedChannels).toContain('chan-blocked');
});

test('should return false and record error when leaving a guild throws', async () => {
  const recordCalls = [];
  let capturedError = null;
  const { leaveDisallowedGuild } = reloadModule(guildAccessPath, () => {
    stubModule(configPath, {
      ...DEFAULT_CONFIG,
      allowedGuildIds: new Set(['allowed-guild'])
    });
    stubModule(discordApiPath, { withDiscordRetry: fn => fn() });
    stubModule(instrumentPath, {
      captureError: err => { capturedError = err; },
      recordCount: (name, value, attrs) => { recordCalls.push({ name, value, attrs }); }
    });
    stubModule(path.resolve(__dirname, '..', 'utils', 'aiUtils.js'), {
      pruneChannelAuxMaps: () => {}
    });
  });

  const client = {
    conversationHistory: new Map(),
    channelGuildIds: new Map()
  };
  const guild = {
    id: 'blocked-guild',
    name: 'Blocked',
    leave: async () => { throw new Error('leave failed'); }
  };

  const left = await leaveDisallowedGuild(client, guild, 'test');

  expect(left).toBe(false);
  expect(capturedError).toBeInstanceOf(Error);
  expect(recordCalls.some(call => call.attrs?.outcome === 'error')).toBe(true);
  expect(client.guildLeaveInProgress.has('blocked-guild')).toBe(false);

  guild.leave = async () => {};
  const retry = await leaveDisallowedGuild(client, guild, 'test');
  expect(retry).toBe(true);
});

test('clearGuildConversationState handles missing maps and unmapped channels', () => {
  const { clearGuildConversationState } = loadGuildAccess();

  expect(() => clearGuildConversationState({}, 'guild-1')).not.toThrow();

  const client = {
    conversationHistory: new Map([['chan-x', []]])
  };
  clearGuildConversationState(client, null);
  expect(client.conversationHistory.has('chan-x')).toBe(false);
});

test('leaveDisallowedGuild returns false without a client or guild id', async () => {
  const { leaveDisallowedGuild } = loadGuildAccess({
    allowedGuildIds: new Set(['allowed-guild'])
  });

  expect(await leaveDisallowedGuild(null, { id: 'blocked' }, 'test')).toBe(false);
  expect(await leaveDisallowedGuild({}, undefined, 'test')).toBe(false);
});

test('leaveDisallowedGuild falls back to "unknown" when the guild has no name', async () => {
  const infoSpy = jest.fn();
  const loggerPath = path.resolve(__dirname, '..', 'logger.js');
  const { leaveDisallowedGuild } = reloadModule(guildAccessPath, () => {
    stubModule(configPath, {
      ...DEFAULT_CONFIG,
      allowedGuildIds: new Set(['allowed-guild'])
    });
    stubModule(discordApiPath, { withDiscordRetry: fn => fn() });
    stubModule(instrumentPath, {
      captureError: () => {},
      recordCount: () => {}
    });
    stubModule(path.resolve(__dirname, '..', 'utils', 'aiUtils.js'), {
      pruneChannelAuxMaps: () => {}
    });
    stubModule(loggerPath, () => ({
      info: infoSpy,
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    }));
  });

  const client = { conversationHistory: new Map(), channelGuildIds: new Map() };
  const guild = { id: 'blocked-guild', name: '', leave: async () => {} };

  const left = await leaveDisallowedGuild(client, guild, 'test');

  expect(left).toBe(true);
  expect(infoSpy).toHaveBeenCalledWith(
    'Left disallowed guild "unknown".',
    expect.objectContaining({ guildName: 'unknown' })
  );
});

test('should not leave allowlisted guild', async () => {
  const { leaveDisallowedGuild } = loadGuildAccess({
    allowedGuildIds: new Set(['allowed-guild'])
  });

  let leaveCount = 0;
  const client = { conversationHistory: new Map() };
  const guild = {
    id: 'allowed-guild',
    name: 'Allowed',
    leave: async () => { leaveCount += 1; }
  };

  const left = await leaveDisallowedGuild(client, guild, 'test');
  expect(left).toBe(false);
  expect(leaveCount).toBe(0);
});
