const path = require('path');
const { stubModule, reloadModule, DEFAULT_CONFIG, defaultInstrumentStub, createMockClient } = require('./testUtils.cjs');

const channelChatHandlerPath = path.resolve(__dirname, '..', 'utils', 'channelChatHandler.js');
const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
const aiUtilsPath = path.resolve(__dirname, '..', 'utils', 'aiUtils.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const discordApiPath = path.resolve(__dirname, '..', 'utils', 'discordApi.js');

function loadHandler({ config = {}, processImageAttachments, aiUtilsOverrides = {} } = {}) {
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
      isAIUserErrorMessage: () => false,
      ...aiUtilsOverrides
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

test('should ensureClientChatState schedules one unref-ed periodic cleanup timer per client', () => {
  const { ensureClientChatState } = loadHandler();
  const client = createClient();

  ensureClientChatState(client);
  const firstInterval = client.chatStateCleanupInterval;
  expect(firstInterval).toBeDefined();

  ensureClientChatState(client);
  expect(client.chatStateCleanupInterval).toBe(firstInterval);

  clearInterval(client.chatStateCleanupInterval);
});

test('should runPeriodicChatStateCleanup prunes histories and cooldown maps on the configured cadence', () => {
  const pruneConversationHistoriesCalls = [];
  const pruneStaleMapEntriesCalls = [];
  const { runPeriodicChatStateCleanup } = loadHandler({
    config: { userCooldownMs: 4000, channelCooldownMs: 1500 },
    aiUtilsOverrides: {
      pruneConversationHistories: (...args) => pruneConversationHistoriesCalls.push(args),
      pruneStaleMapEntries: (...args) => pruneStaleMapEntriesCalls.push(args)
    }
  });

  const client = createClient();
  runPeriodicChatStateCleanup(client);

  expect(pruneConversationHistoriesCalls).toHaveLength(1);
  expect(pruneConversationHistoriesCalls[0][0]).toBe(client.conversationHistory);
  expect(pruneConversationHistoriesCalls[0][1]).toBe(client.channelLastActivity);

  // userCooldownMs 4000, channelCooldownMs 1500 -> max(4000, 1500) * 10 = 40000
  expect(pruneStaleMapEntriesCalls).toEqual([
    [client.userCooldowns, 40000],
    [client.channelCooldowns, 40000]
  ]);
});

test('should runPeriodicChatStateCleanup falls back to a default prune age when a cooldown value is invalid', () => {
  const pruneStaleMapEntriesCalls = [];
  const { runPeriodicChatStateCleanup } = loadHandler({
    // channelCooldownMs > 0 so pruning still runs; userCooldownMs is NaN so Math.max(...) * 10 is NaN.
    config: { userCooldownMs: Number.NaN, channelCooldownMs: 5 },
    aiUtilsOverrides: {
      pruneStaleMapEntries: (...args) => pruneStaleMapEntriesCalls.push(args)
    }
  });

  const client = createClient();
  runPeriodicChatStateCleanup(client);

  // Math.max(NaN, 5) * 10 is NaN, which is falsy for `||`, so it falls back to 600_000.
  expect(pruneStaleMapEntriesCalls).toEqual([
    [client.userCooldowns, 600_000],
    [client.channelCooldowns, 600_000]
  ]);
});

test('should runPeriodicChatStateCleanup skips cooldown pruning when both cooldowns are disabled', () => {
  const pruneStaleMapEntriesCalls = [];
  const { runPeriodicChatStateCleanup } = loadHandler({
    config: { userCooldownMs: 0, channelCooldownMs: 0 },
    aiUtilsOverrides: {
      pruneStaleMapEntries: (...args) => pruneStaleMapEntriesCalls.push(args)
    }
  });

  runPeriodicChatStateCleanup(createClient());

  expect(pruneStaleMapEntriesCalls).toHaveLength(0);
});
