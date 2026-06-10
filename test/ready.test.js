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
