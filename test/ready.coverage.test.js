const test = require('node:test');
const assert = require('node:assert/strict');

test('ready.execute handles startup errors', () => {
  delete require.cache[require.resolve('../events/ready')];
  const ready = require('../events/ready');

  const client = {
    user: {
      tag: 'Bot#0001',
      setActivity: () => {
        throw new Error('activity failed');
      }
    },
    guilds: { cache: new Map([['g1', { id: 'g1', name: 'G1' }]]) }
  };

  assert.doesNotThrow(() => ready.execute(client));
});