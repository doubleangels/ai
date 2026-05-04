const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const resetPath = path.resolve(__dirname, '..', 'commands', 'reset.js');

function loadResetCommand() {
  delete require.cache[resetPath];
  return require(resetPath);
}

test('reset reports when a channel has no history', async () => {
  const command = loadResetCommand();
  const calls = [];
  const interaction = {
    user: { id: 'admin-1', tag: 'Admin#0001' },
    guildId: 'guild-1',
    guild: { name: 'Test Guild' },
    client: {
      channelLocks: new Map(),
      conversationHistory: new Map()
    },
    options: {
      getChannel: () => ({ id: 'chan-1', name: 'general' })
    },
    deferReply: async () => {},
    editReply: async payload => calls.push(payload),
    followUp: async payload => calls.push(payload)
  };

  await command.execute(interaction);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].embeds[0].data.title, '⚠️ No History Found');
});

test('reset reports when no histories exist across all channels', async () => {
  const command = loadResetCommand();
  const calls = [];
  const interaction = {
    user: { id: 'admin-1', tag: 'Admin#0001' },
    guildId: 'guild-1',
    guild: { name: 'Test Guild' },
    client: {
      channelLocks: new Map(),
      conversationHistory: new Map()
    },
    options: {
      getChannel: () => null
    },
    deferReply: async () => {},
    editReply: async payload => calls.push(payload),
    followUp: async payload => calls.push(payload)
  };

  await command.execute(interaction);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].embeds[0].data.title, '⚠️ No History Found');
});

test('reset falls back to followUp when editReply fails', async () => {
  const command = loadResetCommand();
  const calls = [];
  const interaction = {
    user: { id: 'admin-1', tag: 'Admin#0001' },
    guildId: 'guild-1',
    guild: { name: 'Test Guild' },
    client: {
      channelLocks: new Map(),
      conversationHistory: new Map([
        ['chan-1', [{ role: 'system', content: 'sys' }]]
      ])
    },
    options: {
      getChannel: () => ({ id: 'chan-1', name: 'general' })
    },
    deferReply: async () => {},
    editReply: async () => {
      throw new Error('edit failed');
    },
    followUp: async payload => calls.push(payload)
  };

  await command.execute(interaction);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].embeds[0].data.title, '🗑️ Channel History Reset');
});

test('reset handles command errors through the catch path', async () => {
  const command = loadResetCommand();
  const calls = [];
  const interaction = {
    user: { id: 'admin-1', tag: 'Admin#0001' },
    guildId: 'guild-1',
    guild: { name: 'Test Guild' },
    client: {
      channelLocks: new Map(),
      conversationHistory: {
        has: () => true,
        get: () => [{ role: 'system', content: 'sys' }],
        delete: () => {
          throw new Error('delete failed');
        }
      }
    },
    options: {
      getChannel: () => ({ id: 'chan-1', name: 'general' })
    },
    deferReply: async () => {},
    editReply: async payload => calls.push(payload),
    followUp: async payload => calls.push(payload)
  };

  await command.execute(interaction);
  assert.equal(calls.length >= 1, true);
});