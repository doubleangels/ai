const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

test('ready.execute sets activity and logs without throwing', () => {
  delete require.cache[require.resolve('../events/ready')];
  const ready = require('../events/ready');

  const user = { tag: 'Bot#0001', _activity: null };
  user.setActivity = (s, o) => { user._activity = { s, o }; };
  const client = {
    user,
    guilds: { cache: new Map([['g1', { id: 'g1', name: 'G1' }]]) }
  };

  assert.doesNotThrow(() => ready.execute(client));
  assert.ok(user._activity && user._activity.s && user._activity.o);
});

// --- appended from test/ready.coverage.test.js ---
test('ready.execute handles startup errors (coverage merged)', () => {
  delete require.cache[require.resolve('../events/ready')];
  const ready2 = require('../events/ready');

  const client = {
    user: {
      tag: 'Bot#0001',
      setActivity: () => {
        throw new Error('activity failed');
      }
    },
    guilds: { cache: new Map([['g1', { id: 'g1', name: 'G1' }]]) }
  };

  assert.doesNotThrow(() => ready2.execute(client));
});
