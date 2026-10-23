const path = require('path');
const { stubModule, reloadModule, defaultInstrumentStub } = require('./testUtils.cjs');

const askPath = path.resolve(__dirname, '..', 'commands', 'askAI.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const channelChatHandlerPath = path.resolve(__dirname, '..', 'utils', 'channelChatHandler.js');
const aiUtilsPath = path.resolve(__dirname, '..', 'utils', 'aiUtils.js');
const discordApiPath = path.resolve(__dirname, '..', 'utils', 'discordApi.js');

function loadAskCommand({ runChannelChatImpl, queueDepth = 0, media = [] } = {}) {
  const mediaCalls = [];
  const command = reloadModule(askPath, () => {
    stubModule(instrumentPath, defaultInstrumentStub());
    stubModule(configPath, { maxReplyChainImages: 4 });
    stubModule(discordApiPath, { withDiscordRetry: fn => fn() });
    stubModule(aiUtilsPath, {
      collectReplyChainMedia: (chain, botId, options) => {
        mediaCalls.push({ chain, botId, options });
        return { attachments: media };
      }
    });
    stubModule(channelChatHandlerPath, {
      ensureClientChatState: () => {},
      getChannelQueueDepth: () => queueDepth,
      maxPendingPerChannel: 3,
      enqueueChannelChat: async (_client, _channelId, fn) => fn(),
      runChannelChat: runChannelChatImpl || (async () => {})
    });
  });
  return { command, mediaCalls };
}

function createInteraction({ target = { id: 'msg-1', content: 'Is this true?', author: { username: 'alice' } } } = {}) {
  const calls = [];
  const interaction = {
    user: { id: 'user-1', tag: 'User#0001' },
    guildId: 'guild-1',
    channelId: 'chan-1',
    channel: { name: 'general' },
    id: 'interaction-1',
    client: { user: { id: 'bot-1' } },
    targetMessage: target,
    reply: async payload => { calls.push({ type: 'reply', payload }); },
    deferReply: async () => { calls.push({ type: 'deferReply' }); },
    editReply: async payload => { calls.push({ type: 'editReply', payload }); },
    followUp: async payload => { calls.push({ type: 'followUp', payload }); }
  };
  return { interaction, calls };
}

test('should expose a user-installable message context menu', () => {
  const { command } = loadAskCommand();
  const json = command.data.toJSON();
  expect(json.name).toBe('Ask AI');
  expect(json.type).toBe(3);
  expect(json.integration_types).toEqual([0, 1]);
  expect(json.contexts).toEqual([0, 1, 2]);
});

test('should quote the target message and route through channel chat', async () => {
  let captured;
  const { command, mediaCalls } = loadAskCommand({
    runChannelChatImpl: async options => { captured = options; }
  });
  const { interaction, calls } = createInteraction();

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'deferReply')).toBe(true);
  expect(captured.userText).toBe('Reply to this message from alice:\n\nIs this true?');
  expect(captured.trigger).toBe('context_menu');
  expect(captured.channelId).toBe('chan-1');
  expect(captured.channelName).toBe('general');
  expect(mediaCalls[0]).toEqual({ chain: [interaction.targetMessage], botId: null, options: { maxImages: 4 } });
});

test('should send image-only target messages with empty text', async () => {
  let captured;
  const image = { url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png' };
  const { command } = loadAskCommand({
    media: [image],
    runChannelChatImpl: async options => { captured = options; }
  });
  const { interaction } = createInteraction({ target: { id: 'msg-2', content: '', author: null } });
  interaction.channel = null;

  await command.execute(interaction);

  expect(captured.userText).toBe('');
  expect(captured.extraImageAttachments).toEqual([image]);
  expect(captured.channelName).toBe('unknown');
});

test('should reject target messages with nothing readable', async () => {
  const { command } = loadAskCommand();
  const { interaction, calls } = createInteraction({ target: { id: 'msg-3', content: '   ' } });

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'reply' && /no text or images/.test(c.payload.content))).toBe(true);
  expect(calls.some(c => c.type === 'deferReply')).toBe(false);
});

test('should reject when the target message is missing', async () => {
  const { command, mediaCalls } = loadAskCommand();
  const { interaction, calls } = createInteraction({ target: null });

  await command.execute(interaction);

  expect(mediaCalls[0].chain).toEqual([]);
  expect(calls.some(c => c.type === 'reply' && /no text or images/.test(c.payload.content))).toBe(true);
});

test('should apply channel backpressure', async () => {
  const { command } = loadAskCommand({ queueDepth: 3 });
  const { interaction, calls } = createInteraction();

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'reply' && /busy/.test(c.payload.content))).toBe(true);
  expect(calls.some(c => c.type === 'deferReply')).toBe(false);
});

test('should report errors from channel chat', async () => {
  const { command } = loadAskCommand({
    runChannelChatImpl: async () => { throw new Error('run failed'); }
  });
  const { interaction, calls } = createInteraction();

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'editReply' && /Something went wrong/.test(c.payload.content))).toBe(true);
});

test('should swallow failures of the error reply', async () => {
  const { command } = loadAskCommand({
    runChannelChatImpl: async () => { throw new Error('run failed'); }
  });
  const { interaction } = createInteraction();
  interaction.editReply = async () => { throw new Error('edit failed'); };

  await expect(command.execute(interaction)).resolves.toBeUndefined();
});
