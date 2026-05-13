const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

test('ready.execute sets activity and logs without throwing', () => {
  delete require.cache[require.resolve('../events/ready')];
  const ready = require('../events/ready');

  const user = { tag: 'Bot#0001', _presence: null };
  user.setPresence = (p) => { user._presence = p; };
  const client = {
    user,
    guilds: { cache: new Map([['g1', { id: 'g1', name: 'G1' }]]) }
  };

  assert.doesNotThrow(() => ready.execute(client));
  assert.ok(user._presence && user._presence.activities && user._presence.activities[0]);
  assert.strictEqual(user._presence.activities[0].name, 'for mentions! 📢');
});

// --- appended from test/ready.coverage.test.js ---
test('ready.execute handles startup errors (coverage merged)', () => {
  delete require.cache[require.resolve('../events/ready')];
  const ready2 = require('../events/ready');

  const client = {
    user: {
      tag: 'Bot#0001',
      setPresence: () => {
        throw new Error('presence failed');
      }
    },
    guilds: { cache: new Map([['g1', { id: 'g1', name: 'G1' }]]) }
  };

  assert.doesNotThrow(() => ready2.execute(client));
});
