const path = require('path');
const { stubModule, reloadModule, defaultInstrumentStub } = require('./testUtils.cjs');

const chatPath = path.resolve(__dirname, '..', 'commands', 'chat.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const channelChatHandlerPath = path.resolve(__dirname, '..', 'utils', 'channelChatHandler.js');
const discordApiPath = path.resolve(__dirname, '..', 'utils', 'discordApi.js');

function loadChatCommand({ runChannelChatImpl, queueDepth = 0 } = {}) {
  return reloadModule(chatPath, () => {
    stubModule(instrumentPath, defaultInstrumentStub());
    stubModule(configPath, {});
    stubModule(discordApiPath, { withDiscordRetry: fn => fn() });
    stubModule(channelChatHandlerPath, {
      ensureClientChatState: () => {},
      getChannelQueueDepth: () => queueDepth,
      maxPendingPerChannel: 3,
      enqueueChannelChat: async (_client, _channelId, fn) => fn(),
      runChannelChat: runChannelChatImpl || (async () => {})
    });
  });
}

function createInteraction({ message = 'hello', image = null, queueDepth = 0 } = {}) {
  const calls = [];
  const interaction = {
    user: { id: 'user-1', tag: 'User#0001' },
    guildId: 'guild-1',
    channelId: 'chan-1',
    channel: { name: 'general' },
    id: 'interaction-1',
    client: {
      conversationHistory: new Map(),
      user: { id: 'bot-1' }
    },
    options: {
      getString: name => (name === 'message' ? message : null),
      getAttachment: name => (name === 'image' ? image : null)
    },
    reply: async payload => {
      calls.push({ type: 'reply', payload });
    },
    deferReply: async () => {
      calls.push({ type: 'deferReply' });
    },
    editReply: async payload => {
      calls.push({ type: 'editReply', payload });
    },
    followUp: async payload => {
      calls.push({ type: 'followUp', payload });
    }
  };

  if (queueDepth > 0) {
    interaction.client.channelQueueDepth = new Map([[ 'chan-1', queueDepth ]]);
  }

  return { interaction, calls };
}

test('should reject /chat when message and image are both missing', async () => {
  const command = loadChatCommand();
  const { interaction, calls } = createInteraction({ message: '' });

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'reply' && c.payload.content.match(/message or an image/))).toBe(true);
  expect(calls.some(c => c.type === 'deferReply')).toBe(false);
});

test('should defer and run channel chat for /chat message', async () => {
  let captured;
  const command = loadChatCommand({
    runChannelChatImpl: async options => {
      captured = options;
    }
  });
  const { interaction, calls } = createInteraction({ message: 'What is 2+2?' });

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'deferReply')).toBe(true);
  expect(captured.userText).toBe('What is 2+2?');
  expect(captured.trigger).toBe('slash');
  expect(captured.channelId).toBe('chan-1');
});

test('should pass image attachment to channel chat handler', async () => {
  let captured;
  const command = loadChatCommand({
    runChannelChatImpl: async options => {
      captured = options;
    }
  });
  const image = { url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png' };
  const { interaction } = createInteraction({ message: '', image });

  await command.execute(interaction);

  expect(captured.extraImageAttachments).toEqual([image]);
});

test('should block /chat when channel backpressure is active', async () => {
  const command = loadChatCommand({ queueDepth: 3 });
  const { interaction, calls } = createInteraction();

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'reply' && c.payload.content.match(/busy/))).toBe(true);
  expect(calls.some(c => c.type === 'deferReply')).toBe(false);
});

test('should expose chat slash command metadata', () => {
  const command = loadChatCommand();
  const json = command.data.toJSON();
  expect(json.name).toBe('chat');
});
