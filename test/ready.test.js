const fs = require('fs');
const path = require('path');
const { reloadModule } = require('./testUtils.cjs');

const readyPath = path.resolve(__dirname, '..', 'events', 'ready.js');

test('should ready.execute sets activity and logs without throwing', () => {
  const ready = reloadModule(readyPath);

  const user = { tag: 'Bot#0001', _presence: null };
  user.setPresence = (p) => { user._presence = p; };
  const client = {
    discordReady: false,
    user,
    guilds: { cache: new Map([['g1', { id: 'g1', name: 'G1' }]]) }
  };
  const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

  expect(() => ready.execute(client)).not.toThrow();
  expect(client.discordReady).toBe(true);
  writeSpy.mockRestore();
  expect(user._presence && user._presence.activities && user._presence.activities[0]).toBeTruthy();
  expect(user._presence.activities[0].name).toBe('for mentions! 📢');
});

test('should ready.execute handles startup errors (coverage merged)', () => {
  const ready2 = reloadModule(readyPath);

  const client = {
    user: {
      tag: 'Bot#0001',
      setPresence: () => {
        throw new Error('presence failed');
      }
    },
    guilds: { cache: new Map([['g1', { id: 'g1', name: 'G1' }]]) }
  };

  expect(() => ready2.execute(client)).not.toThrow();
});

test('should ready logs when ready marker write fails', () => {
  const ready3 = reloadModule(readyPath);
  const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
    throw new Error('write failed');
  });
  const client = {
    discordReady: false,
    user: {
      tag: 'Bot#0001',
      setPresence: () => {}
    },
    guilds: { cache: new Map() }
  };

  expect(() => ready3.execute(client)).not.toThrow();
  expect(client.discordReady).toBe(true);
  writeSpy.mockRestore();
});

test('should ready logs first 25 guild names on startup', async () => {
  const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

  const guilds = new Map();
  for (let i = 0; i < 30; i += 1) {
    guilds.set(`g${i}`, { id: `g${i}`, name: `Guild ${i}` });
  }

  const user = { tag: 'Bot#0001', _presence: null };
  user.setPresence = (p) => { user._presence = p; };
  const client = {
    discordReady: false,
    user,
    guilds: { cache: guilds }
  };

  const loggerPath = path.resolve(__dirname, '..', 'logger.js');
  const infoSpy = jest.fn();
  const readyWithSpy = reloadModule(readyPath, () => {
    const { stubModule } = require('./testUtils.cjs');
    stubModule(loggerPath, () => ({
      info: infoSpy,
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    }));
  });

  await readyWithSpy.execute(client);

  const summaryCall = infoSpy.mock.calls.find(args => args[0] === 'Bot guild summary.');
  expect(summaryCall).toBeTruthy();
  expect(summaryCall[1].guildCount).toBe(30);
  expect(summaryCall[1].guildNames).toHaveLength(25);
  expect(summaryCall[1].guildNames[0]).toBe('Guild 0');
  expect(summaryCall[1].guildNames[24]).toBe('Guild 24');

  writeSpy.mockRestore();
});

test('should label guilds without a name as unknown in the summary', async () => {
  const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  const client = {
    discordReady: false,
    user: { tag: 'Bot#0001', setPresence: () => {} },
    guilds: { cache: new Map([['g1', { id: 'g1' }]]) }
  };

  const loggerPath = path.resolve(__dirname, '..', 'logger.js');
  const infoSpy = jest.fn();
  const readyWithSpy = reloadModule(readyPath, () => {
    const { stubModule } = require('./testUtils.cjs');
    stubModule(loggerPath, () => ({
      info: infoSpy,
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    }));
  });

  await readyWithSpy.execute(client);

  const summaryCall = infoSpy.mock.calls.find(args => args[0] === 'Bot guild summary.');
  expect(summaryCall[1].guildNames).toContain('unknown');
  writeSpy.mockRestore();
});

test('should leave disallowed guilds on startup', async () => {
  const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  const guildAccessPath = path.resolve(__dirname, '..', 'utils', 'guildAccess.js');
  const leaveDisallowedGuilds = jest.fn().mockResolvedValue(1);

  const ready = reloadModule(readyPath, () => {
    const { stubModule } = require('./testUtils.cjs');
    stubModule(guildAccessPath, {
      leaveDisallowedGuilds,
      isGuildAllowlisted: () => true,
      leaveDisallowedGuild: jest.fn(),
      clearGuildConversationState: jest.fn()
    });
  });

  const client = {
    discordReady: false,
    user: {
      tag: 'Bot#0001',
      setPresence: () => {}
    },
    guilds: { cache: new Map() }
  };

  await ready.execute(client);

  expect(leaveDisallowedGuilds).toHaveBeenCalledWith(client, 'ready');
  writeSpy.mockRestore();
});

test('should ready logs shard metadata when sharding is enabled', () => {
  const ready = reloadModule(readyPath);
  const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  const client = {
    discordReady: false,
    shard: { ids: [2], count: 4 },
    user: {
      id: 'bot-1',
      tag: 'Bot#0001',
      setPresence: () => {}
    },
    guilds: { cache: new Map() }
  };

  expect(() => ready.execute(client)).not.toThrow();
  writeSpy.mockRestore();
});
