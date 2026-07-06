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
