
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

test('should waits for the existing channel lock before clearing channel history', async () => {
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
  expect(resetCompleted).toBe(false);
  expect(interaction.client.conversationHistory.has('chan-1')).toBe(true);

  gate.resolve();
  await execution;

  expect(interaction.client.conversationHistory.has('chan-1')).toBe(false);
});

test('should clears all histories only after existing locks settle', async () => {
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
  expect(resetCompleted).toBe(false);
  expect(interaction.client.conversationHistory.size).toBe(2);

  gate.resolve();
  await execution;

  expect(interaction.client.conversationHistory.size).toBe(0);
});

// --- appended from test/reset.coverage.test.js ---

test('should reset reports when a channel has no history (coverage merged)', async () => {
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
  expect(calls.length).toBe(1);
  expect(calls[0].embeds[0].data.title).toBe('⚠️ No History Found');
});

test('should reset reports when no histories exist across all channels (coverage merged)', async () => {
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
  expect(calls.length).toBe(1);
  expect(calls[0].embeds[0].data.title).toBe('⚠️ No History Found');
});

test('should reset falls back to followUp when editReply fails (coverage merged)', async () => {
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
  expect(calls.length).toBe(1);
  expect(calls[0].embeds[0].data.title).toBe('🗑️ Channel History Reset');
});

test('should reset logs when followUp fails after editReply fails', async () => {
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

  await expect(command.execute(interaction)).resolves.not.toThrow();
});

test('should reset logs when error reply followUp fails', async () => {
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

  await expect(command.execute(interaction)).resolves.not.toThrow();
});

test('should reset handles command errors through the catch path (coverage merged)', async () => {
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
  expect(calls.length >= 1).toBe(true);
});
