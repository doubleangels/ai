const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');

const resetPath = path.resolve(__dirname, '..', 'commands', 'reset.js');

function loadResetCommand() {
  delete require.cache[resetPath];
  return require(resetPath);
}

function createInteraction({ channelOption = null } = {}) {
  const calls = [];
  const interaction = {
    user: { id: 'admin-1', tag: 'Admin#0001' },
    guildId: 'guild-1',
    guild: { name: 'Test Guild' },
    client: {
      channelLocks: new Map(),
      conversationHistory: new Map([
        ['chan-1', [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }]]
      ])
    },
    options: {
      getChannel: () => channelOption
    },
    deferReply: async () => {
      calls.push('deferReply');
    },
    editReply: async () => {
      calls.push('editReply');
    },
    followUp: async () => {
      calls.push('followUp');
    }
  };

  return { interaction, calls };
}

test('waits for the existing channel lock before clearing channel history', async () => {
  const command = loadResetCommand();
  const gate = {};
  gate.promise = new Promise(resolve => {
    gate.resolve = resolve;
  });

  const { interaction } = createInteraction({
    channelOption: { id: 'chan-1', name: 'general' }
  });
  interaction.client.channelLocks.set('chan-1', gate.promise);

  let resetCompleted = false;
  const execution = command.execute(interaction).then(() => {
    resetCompleted = true;
  });

  await Promise.resolve();
  assert.equal(resetCompleted, false);
  assert.equal(interaction.client.conversationHistory.has('chan-1'), true);

  gate.resolve();
  await execution;

  assert.equal(interaction.client.conversationHistory.has('chan-1'), false);
});

test('clears all histories only after existing locks settle', async () => {
  const command = loadResetCommand();
  const gate = {};
  gate.promise = new Promise(resolve => {
    gate.resolve = resolve;
  });

  const { interaction } = createInteraction();
  interaction.client.channelLocks.set('chan-1', gate.promise);
  interaction.client.conversationHistory.set('chan-2', [{ role: 'system', content: 'sys' }, { role: 'user', content: 'other' }]);

  let resetCompleted = false;
  const execution = command.execute(interaction).then(() => {
    resetCompleted = true;
  });

  await Promise.resolve();
  assert.equal(resetCompleted, false);
  assert.equal(interaction.client.conversationHistory.size, 2);

  gate.resolve();
  await execution;

  assert.equal(interaction.client.conversationHistory.size, 0);
});
