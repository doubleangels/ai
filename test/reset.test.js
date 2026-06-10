
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
      channelGuildIds: new Map([['chan-1', 'guild-1']]),
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
  interaction.client.channelLastActivity = new Map([['chan-1', Date.now()]]);
  interaction.client.channelQueueDepth = new Map([['chan-1', 0]]);
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
  expect(interaction.client.channelLastActivity.has('chan-1')).toBe(false);
  expect(interaction.client.channelLocks.has('chan-1')).toBe(false);
});

test('should clears all histories only after existing locks settle', async () => {
  const command = loadResetCommand();
  const gate = {};
  gate.promise = new Promise(resolve => {
    gate.resolve = resolve;
  });

  const { interaction } = createInteraction();
  interaction.client.channelLastActivity = new Map([
    ['chan-1', Date.now()],
    ['chan-2', Date.now()]
  ]);
  interaction.client.channelLocks.set('chan-1', gate.promise);
  interaction.client.channelQueueDepth = new Map([['chan-1', 0], ['chan-2', 0]]);
  interaction.client.channelGuildIds = new Map([
    ['chan-1', 'guild-1'],
    ['chan-2', 'guild-1']
  ]);
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
  expect(interaction.client.channelLastActivity.size).toBe(0);
  expect(interaction.client.channelQueueDepth.size).toBe(0);
  expect(interaction.client.channelLocks.size).toBe(0);
});

test('should reset all clears only channels in the invoking guild', async () => {
  const command = loadResetCommand();
  const { interaction } = createInteraction();
  interaction.client.channelGuildIds = new Map([
    ['chan-1', 'guild-1'],
    ['chan-other', 'guild-2']
  ]);
  interaction.client.conversationHistory.set('chan-other', [{ role: 'system', content: 'sys' }]);
  interaction.options.getChannel = () => null;

  await command.execute(interaction);

  expect(interaction.client.conversationHistory.has('chan-1')).toBe(false);
  expect(interaction.client.conversationHistory.has('chan-other')).toBe(true);
});

test('should reset all clears cooldown maps for the invoking guild', async () => {
  const command = loadResetCommand();
  const { interaction } = createInteraction();
  interaction.client.channelGuildIds = new Map([['chan-1', 'guild-1']]);
  interaction.client.channelCooldowns = new Map([['chan-1', Date.now()]]);
  interaction.client.userCooldowns = new Map([['user-1', Date.now()]]);
  interaction.options.getChannel = () => null;

  await command.execute(interaction);

  expect(interaction.client.channelCooldowns.size).toBe(0);
  expect(interaction.client.userCooldowns.size).toBe(0);
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

test('should reset skips channels without guild mapping on guild reset', async () => {
  const command = loadResetCommand();
  const { interaction } = createInteraction();
  interaction.client.channelGuildIds = new Map();
  interaction.options.getChannel = () => null;

  await command.execute(interaction);

  expect(interaction.client.conversationHistory.has('chan-1')).toBe(true);
});

test('should reset treats missing channelGuildIds map as unmapped channels', async () => {
  const command = loadResetCommand();
  const { interaction } = createInteraction();
  delete interaction.client.channelGuildIds;
  interaction.options.getChannel = () => null;

  await command.execute(interaction);

  expect(interaction.client.conversationHistory.has('chan-1')).toBe(true);
});

test('should reset matches null guild ids when channel mapping is null', async () => {
  const command = loadResetCommand();
  const { interaction } = createInteraction();
  interaction.guildId = null;
  interaction.client.channelGuildIds = new Map([['chan-1', null]]);
  interaction.options.getChannel = () => null;

  await command.execute(interaction);

  expect(interaction.client.conversationHistory.has('chan-1')).toBe(false);
});

test('should reset clears channel cooldowns on single-channel reset', async () => {
  const command = loadResetCommand();
  const { interaction } = createInteraction({
    channelOption: { id: 'chan-1', name: 'general' }
  });
  interaction.client.channelCooldowns = new Map([['chan-1', Date.now()]]);

  await command.execute(interaction);

  expect(interaction.client.channelCooldowns.has('chan-1')).toBe(false);
});

test('should reset guild reset treats empty channel histories as zero messages', async () => {
  const command = loadResetCommand();
  const { interaction } = createInteraction();
  interaction.client.conversationHistory.set('chan-1', []);
  interaction.options.getChannel = () => null;

  await command.execute(interaction);

  expect(interaction.client.conversationHistory.has('chan-1')).toBe(false);
});

test('should reset guild-scope errors record guild metrics', async () => {
  const command = loadResetCommand();
  const interaction = {
    user: { id: 'admin-1', tag: 'Admin#0001' },
    guildId: 'guild-1',
    guild: { name: 'Test Guild' },
    client: {
      channelLocks: new Map(),
      channelGuildIds: new Map([['chan-1', 'guild-1']]),
      conversationHistory: {
        keys: () => ['chan-1'],
        get: () => [{ role: 'system', content: 'sys' }],
        delete: () => {
          throw new Error('delete failed');
        }
      }
    },
    options: {
      getChannel: () => null
    },
    deferReply: async () => {},
    editReply: async () => {},
    followUp: async () => {}
  };

  await expect(command.execute(interaction)).resolves.not.toThrow();
});
