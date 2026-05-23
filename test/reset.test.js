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

// --- appended from test/reset.coverage.test.js ---

test('reset reports when a channel has no history (coverage merged)', async () => {
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

test('reset reports when no histories exist across all channels (coverage merged)', async () => {
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

test('reset falls back to followUp when editReply fails (coverage merged)', async () => {
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

test('reset logs when followUp fails after editReply fails', async () => {
  const command = loadResetCommand();
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
    followUp: async () => {
      throw new Error('followUp failed');
    }
  };

  await assert.doesNotReject(async () => command.execute(interaction));
});

test('reset logs when error reply followUp fails', async () => {
  const command = loadResetCommand();
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
    editReply: async () => {
      throw new Error('edit failed');
    },
    followUp: async () => {
      throw new Error('followUp failed');
    }
  };

  await assert.doesNotReject(async () => command.execute(interaction));
});

test('reset handles command errors through the catch path (coverage merged)', async () => {
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
