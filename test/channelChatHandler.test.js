const path = require('path');
const { stubModule, reloadModule, DEFAULT_CONFIG, defaultInstrumentStub, createMockClient } = require('./testUtils.cjs');

const channelChatHandlerPath = path.resolve(__dirname, '..', 'utils', 'channelChatHandler.js');
const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
const aiUtilsPath = path.resolve(__dirname, '..', 'utils', 'aiUtils.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const discordApiPath = path.resolve(__dirname, '..', 'utils', 'discordApi.js');

function loadHandler({ config = {}, processImageAttachments } = {}) {
  return reloadModule(channelChatHandlerPath, () => {
    stubModule(discordApiPath, { withDiscordRetry: fn => fn() });
    stubModule(configPath, {
      ...DEFAULT_CONFIG,
      userCooldownMs: 0,
      channelCooldownMs: 0,
      maxReplyChainImages: 2,
      ...config
    });
    stubModule(aiServicePath, { generateAIResponse: async () => 'ok' });
    stubModule(instrumentPath, defaultInstrumentStub());
    stubModule(aiUtilsPath, {
      splitMessage: text => [text],
      processImageAttachments: processImageAttachments || (async attachments => attachments.map(() => ({ type: 'input_image' }))),
      collectReplyChainMedia: () => ({ attachments: [], truncated: false, attachmentSources: [], embedSources: [] }),
      createMessageContent: text => [{ type: 'input_text', text }],
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: { IMAGE_DESCRIPTION_PROMPT: 'describe' },
      pruneStaleMapEntries: () => {},
      pruneConversationHistories: () => {},
      stripImagesFromHistory: () => {},
      formatAIUserMessage: () => 'error message',
      isAIUserErrorMessage: () => false
    });
  });
}

function createClient() {
  return createMockClient();
}

test('should cap extra image attachments at maxReplyChainImages', async () => {
  const processed = [];
  const { runChannelChat } = loadHandler({
    processImageAttachments: async attachments => {
      processed.push(...attachments);
      return attachments.map(() => ({ type: 'input_image' }));
    }
  });

  const client = createClient();
  const extraImageAttachments = [
    { url: 'a' },
    { url: 'b' },
    { url: 'c' }
  ];

  await runChannelChat({
    client,
    channelId: 'chan-1',
    guildId: 'guild-1',
    userId: 'user-1',
    userTag: 'User#0001',
    channelName: 'general',
    userText: 'hello',
    trigger: 'slash',
    messageId: 'msg-1',
    replyChain: [],
    extraImageAttachments,
    startedAt: Date.now(),
    queueDepth: 1,
    delivery: {
      sendUserCooldown: async () => {},
      sendChannelCooldown: async () => {},
      createThinkingPlaceholder: async () => null,
      sendPrimaryResponse: async () => true,
      sendAdditionalChunk: async () => true
    }
  });

  expect(processed).toHaveLength(2);
});
