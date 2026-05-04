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
