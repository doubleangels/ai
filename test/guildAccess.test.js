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
