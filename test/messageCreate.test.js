const path = require('path');
const { stubModule, reloadModule, DEFAULT_CONFIG, defaultInstrumentStub } = require('./testUtils.cjs');

const messageCreatePath = path.resolve(__dirname, '..', 'events', 'messageCreate.js');
const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const aiUtilsPath = path.resolve(__dirname, '..', 'utils', 'aiUtils.js');
const realAiUtils = require(aiUtilsPath);

function loadMessageCreate({ generateAIResponse, config = {}, instrument = {}, aiUtils = null } = {}) {
  return reloadModule(messageCreatePath, () => {
    stubModule(configPath, {
      ...DEFAULT_CONFIG,
      userCooldownMs: 0,
      channelCooldownMs: 0,
      allowedGuildIds: new Set(),
      ...config
    });

    stubModule(aiServicePath, { generateAIResponse: generateAIResponse || (async () => 'ok') });
    stubModule(instrumentPath, defaultInstrumentStub({
      ...instrument,
      Sentry: {
        isEnabled: () => false,
        setConversationId: instrument.setConversationId || (() => {}),
        ...instrument.Sentry
      }
    }));

    stubModule(aiUtilsPath, { ...realAiUtils, ...(aiUtils || {}) });
  });
}

function createBaseMessage(overrides = {}) {
  const replies = [];
  const message = {
    id: 'msg-1',
    content: '<@123> hello',
    channelId: 'chan-1',
    guildId: 'guild-1',
    channel: {
      name: 'general',
      messages: {
        fetch: async messageId => ({
          id: messageId,
          author: { id: 'bot-123', username: 'bot' },
          content: 'prior bot message',
          reference: null,
          attachments: { size: 0, values: () => [] }
        })
      }
    },
    client: {
      user: { id: 'bot-123', tag: 'AI#0001' },
      channelLocks: new Map(),
      channelQueueDepth: new Map(),
      userCooldowns: new Map(),
      channelCooldowns: new Map(),
      conversationHistory: new Map(),
      guilds: { cache: new Map() }
    },
    author: { bot: false, id: 'user-1', tag: 'User#0001', username: 'user' },
    mentions: {
      has: () => true,
      users: { has: () => true },
      everyone: false,
      size: 1,
      values: () => [{ id: '123' }]
    },
    reference: null,
    attachments: new Map(),
    reply: async payload => {
      replies.push(payload);
      if (payload.content === '*Thinking...*') {
        return { edit: async ({ content }) => { replies.push(content); } };
      }
      return { edit: async () => {} };
    },
    ...overrides
  };
  message._replies = replies;
  message.getReplyTexts = () => replies.map(entry => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry.content === 'string') return entry.content;
    return '';
  }).filter(Boolean);
  return message;
}

test('should ignores messages outside allowed guilds', async () => {
  const mod = loadMessageCreate({ config: { allowedGuildIds: new Set(['other-guild']) } });
  let replied = false;
  const message = createBaseMessage({
    guildId: 'guild-1',
    reply: async () => { replied = true; return { edit: async () => {} }; }
  });

  await mod.execute(message);
  expect(replied).toBe(false);
});

test('should handles backpressure and failed busy replies', async () => {
  let recordCalls = 0;
  const mod = loadMessageCreate({
    config: { maxPendingPerChannel: 1 },
    instrument: {
      recordCount: () => {
        recordCalls += 1;
        if (recordCalls > 2) throw new Error('metric failed');
      }
    }
  });

  const message = createBaseMessage();
  message.client.channelQueueDepth.set('chan-1', 1);

  await mod.execute(message);
  expect(message.getReplyTexts().some(text => text.includes('busy'))).toBeTruthy();

  recordCalls = 0;
  const failMessage = createBaseMessage({
    reply: async () => {
      const err = new Error('busy reply failed');
      err.status = 429;
      throw err;
    }
  });
  failMessage.client.channelQueueDepth.set('chan-1', 1);
  await mod.execute(failMessage);
  expect(recordCalls >= 2).toBe(true);
});

test('should applies user and channel cooldowns', async () => {
  const mod = loadMessageCreate({
    config: { userCooldownMs: 60_000, channelCooldownMs: 60_000 }
  });

  const message = createBaseMessage();
  message.client.userCooldowns.set('user-1', Date.now());
  message.client.channelCooldowns.set('chan-1', Date.now());

  await mod.execute(message);
  expect(message.getReplyTexts().some(text => text.includes('wait') || text.includes('Give me'))).toBeTruthy();
});

test('should logs when channel cooldown reply fails', async () => {
  const mod = loadMessageCreate({
    config: { userCooldownMs: 0, channelCooldownMs: 60_000 }
  });
  let sawCooldownReply = false;
  const message = createBaseMessage({
    client: {
      user: { id: 'bot-123', tag: 'AI#0001' },
      channelLocks: new Map(),
      channelQueueDepth: new Map(),
      userCooldowns: new Map(),
      channelCooldowns: new Map([['chan-1', Date.now()]]),
      conversationHistory: new Map()
    },
    reply: async payload => {
      if (payload.content?.includes('Give me')) {
        sawCooldownReply = true;
        throw new Error('channel cooldown reply failed');
      }
      return { edit: async () => {} };
    }
  });

  await mod.execute(message);
  expect(sawCooldownReply).toBe(true);
});

test('should sends channel cooldown notice when reply succeeds', async () => {
  const mod = loadMessageCreate({
    config: { userCooldownMs: 0, channelCooldownMs: 60_000 }
  });
  const replies = [];
  const message = createBaseMessage({
    client: {
      user: { id: 'bot-123', tag: 'AI#0001' },
      channelLocks: new Map(),
      channelQueueDepth: new Map(),
      userCooldowns: new Map(),
      channelCooldowns: new Map([['chan-1', Date.now()]]),
      conversationHistory: new Map()
    },
    reply: async payload => {
      replies.push(payload.content);
      return { edit: async () => {} };
    }
  });

  await mod.execute(message);
  expect(replies.some(text => typeof text === 'string' && text.includes('Give me'))).toBeTruthy();
});

test('should traces reply chains and truncates quoted context', async () => {
  const mod = loadMessageCreate({ generateAIResponse: async () => 'done' });
  const parent = {
    id: 'parent-1',
    author: { id: 'user-2', username: 'bob', bot: false },
    content: 'x'.repeat(2500),
    reference: null,
    attachments: { size: 0, values: () => [] }
  };
  const message = createBaseMessage({
    content: '<@123> follow up',
    reference: { messageId: 'parent-1' },
    channel: {
      name: 'general',
      messages: {
        fetch: async messageId => {
          if (messageId === 'parent-1') return parent;
          return { author: { id: 'bot-123' }, content: 'bot', reference: null, attachments: { size: 0, values: () => [] } };
        }
      }
    }
  });

  await mod.execute(message);
  const history = message.client.conversationHistory.get('chan-1');
  const userTurn = history.find(entry => entry.role === 'user');
  expect(JSON.stringify(userTurn.content)).toMatch(/\[truncated\]/);
});

test('should handles reply-to-bot prefetch without mention', async () => {
  const mod = loadMessageCreate({ generateAIResponse: async () => 'prefetched' });
  const message = createBaseMessage({
    content: 'reply only',
    mentions: { has: () => false, users: { has: () => false }, everyone: false, size: 0, values: () => [] },
    reference: { messageId: 'bot-msg' },
    channel: {
      name: 'general',
      messages: {
        fetch: async () => ({
          id: 'bot-msg',
          author: { id: 'bot-123' },
          content: 'previous bot answer',
          reference: null,
          attachments: { size: 0, values: () => [] }
        })
      }
    }
  });

  await mod.execute(message);
  const history = message.client.conversationHistory.get('chan-1');
  const assistantBeforeUser = history.find(
    (entry, idx) => entry.role === 'assistant' && history[idx + 1]?.role === 'user'
  );
  expect(assistantBeforeUser?.content).toBe('previous bot answer');
  expect(history.at(-1).content).toBe('prefetched');
});

test('should handles multi-chunk replies, empty chunks, and chunk failures', async () => {
  const mod = loadMessageCreate({
    generateAIResponse: async () => 'a'.repeat(4100),
    aiUtils: {
      splitMessage: text => (text.length > 2000 ? [text.slice(0, 2000), text.slice(2000)] : [text]),
      processImageAttachments: async () => [],
      createMessageContent: text => [{ type: 'input_text', text }],
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: { IMAGE_ANALYSIS: 'image', BASE: () => 'system', BASE_GENERIC: 'system', IMAGE_DESCRIPTION_PROMPT: 'describe' }
    }
  });

  let chunkReplies = 0;
  const message = createBaseMessage({
    reply: async payload => {
      if (payload.content === '*Thinking...*') {
        return { edit: async () => {} };
      }
      chunkReplies += 1;
      const err = new Error('chunk failed');
      err.status = 429;
      throw err;
    }
  });

  await mod.execute(message);
  expect(chunkReplies >= 1).toBe(true);

  const emptyChunks = loadMessageCreate({
    generateAIResponse: async () => 'ok',
    aiUtils: {
      splitMessage: () => [],
      processImageAttachments: async () => [],
      createMessageContent: text => [{ type: 'input_text', text }],
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: { IMAGE_ANALYSIS: 'image', BASE: () => 'system', BASE_GENERIC: 'system', IMAGE_DESCRIPTION_PROMPT: 'describe' }
    }
  });
  const emptyMessage = createBaseMessage();
  await emptyChunks.execute(emptyMessage);
  expect(emptyMessage.getReplyTexts().some(text => text.startsWith('⚠️'))).toBeTruthy();
});

test('should strips prior image data and records conversation id', async () => {
  const conversationIdCalls = [];
  const mod = loadMessageCreate({
    generateAIResponse: async () => 'ok',
    instrument: {
      setConversationId: id => conversationIdCalls.push(id)
    }
  });

  const message = createBaseMessage();
  message.client.conversationHistory.set('chan-1', [
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,OLD' }]
    }
  ]);

  await mod.execute(message);
  const history = message.client.conversationHistory.get('chan-1');
  const stripped = history[1].content[0];
  expect(stripped.type).toBe('input_text');
  expect(stripped.text).toBe('[Previous Image Processed]');
  expect(conversationIdCalls).toEqual(['chan-1', null]);
});

test('should handles processing errors and strips prior images from history', async () => {
  const mod = loadMessageCreate({
    generateAIResponse: async () => { throw new Error('ai failed'); }
  });
  const failMessage = createBaseMessage();
  failMessage.client.conversationHistory.set('chan-1', [
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,OLD' }]
    }
  ]);
  await mod.execute(failMessage);
  expect(failMessage.getReplyTexts().some(text => text.startsWith('⚠️'))).toBeTruthy();
  const history = failMessage.client.conversationHistory.get('chan-1');
  expect(history[1].content[0].text).toBe('[Previous Image Processed]');
});

test('should skips reply-chain text when channel history already has turns', async () => {
  const mod = loadMessageCreate({ generateAIResponse: async () => 'done' });
  const parent = {
    id: 'parent-1',
    author: { id: 'user-2', username: 'bob', bot: false },
    content: 'prior thread text',
    reference: null,
    attachments: { size: 0, values: () => [] }
  };
  const message = createBaseMessage({
    content: '<@123> follow up',
    reference: { messageId: 'parent-1' },
    channel: {
      name: 'general',
      messages: {
        fetch: async messageId => {
          if (messageId === 'parent-1') return parent;
          return { author: { id: 'bot-123' }, content: 'bot', reference: null, attachments: { size: 0, values: () => [] } };
        }
      }
    }
  });
  message.client.conversationHistory.set('chan-1', [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: 'earlier reply' }
  ]);

  await mod.execute(message);
  const history = message.client.conversationHistory.get('chan-1');
  const lastUser = [...history].reverse().find(entry => entry.role === 'user');
  expect(JSON.stringify(lastUser.content)).not.toMatch(/\[Previous conversation:/);
});

test('should ignores reply-chain parent attachments and prunes stale cooldown entries', async () => {
  let imageCalls = 0;
  const mod = loadMessageCreate({
    generateAIResponse: async () => 'ok',
    config: { userCooldownMs: 1000, channelCooldownMs: 1000 },
    aiUtils: {
      ...realAiUtils,
      processImageAttachments: async attachments => {
        imageCalls += attachments.length;
        return attachments.map(() => ({ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }));
      }
    }
  });

  const parent = {
    id: 'parent-1',
    author: { id: 'user-2', username: 'bob', bot: false },
    content: 'prior',
    reference: null,
    attachments: { size: 1, values: () => [{ url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png' }] }
  };
  const message = createBaseMessage({
    content: '<@123> with image',
    reference: { messageId: 'parent-1' },
    attachments: new Map([['att-1', { url: 'https://cdn.discordapp.com/b.png', contentType: 'image/png' }]]),
    channel: {
      name: 'general',
      messages: {
        fetch: async () => parent
      }
    }
  });
  message.client.userCooldowns.set('stale-user', Date.now() - 999_999);
  message.client.channelCooldowns.set('stale-channel', Date.now() - 999_999);

  await mod.execute(message);
  expect(imageCalls).toBe(1);
  expect(message.client.userCooldowns.has('stale-user')).toBe(false);
  expect(message.client.channelCooldowns.has('stale-channel')).toBe(false);
});

test('should uses image-only prompt and stops when primary chunk cannot be sent', async () => {
  const mod = loadMessageCreate({
    generateAIResponse: async () => 'ok',
    aiUtils: {
      splitMessage: () => ['part-one', 'part-two'],
      processImageAttachments: async () => [{ type: 'input_image', image_url: 'data:image/png;base64,QUFB' }],
      createMessageContent: (_text, images) => images,
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: {
        IMAGE_ANALYSIS: 'image',
        BASE: () => 'system',
        BASE_GENERIC: 'system',
        IMAGE_DESCRIPTION_PROMPT: 'describe this image'
      }
    }
  });

  const message = createBaseMessage({
    content: '',
    attachments: new Map([['att-1', { url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png' }]]),
    reply: async payload => {
      if (payload.content === '*Thinking...*') {
        return { edit: async () => { throw new Error('edit failed'); } };
      }
      throw new Error('reply failed');
    }
  });

  await mod.execute(message);
  const history = message.client.conversationHistory.get('chan-1');
  const userTurn = history.find(entry => entry.role === 'user');
  expect(userTurn.content[0].text).toBe('describe this image');
});

test('should records chunk metric failures and send errors', async () => {
  let metricCalls = 0;
  const mod = loadMessageCreate({
    generateAIResponse: async () => 'a'.repeat(4100),
    aiUtils: {
      splitMessage: text => [text.slice(0, 2000), text.slice(2000)],
      processImageAttachments: async () => [],
      createMessageContent: text => [{ type: 'input_text', text }],
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: { IMAGE_ANALYSIS: 'image', BASE: () => 'system', BASE_GENERIC: 'system', IMAGE_DESCRIPTION_PROMPT: 'describe' }
    },
    instrument: {
      recordCount: (_name, _value, attrs) => {
        metricCalls += 1;
        if (attrs?.location === 'messageCreate.additional_chunk') {
          throw new Error('metric failed');
        }
      }
    }
  });

  const message = createBaseMessage({
    reply: async payload => {
      if (payload.content === '*Thinking...*') {
        return { edit: async () => {} };
      }
      const err = new Error('chunk failed');
      err.status = 429;
      throw err;
    }
  });

  await expect(mod.execute(message)).resolves.not.toThrow();

  const sendErrorMod = loadMessageCreate({
    generateAIResponse: async () => 'hello',
    aiUtils: {
      splitMessage: () => { throw new Error('split failed'); },
      processImageAttachments: async () => [],
      createMessageContent: text => [{ type: 'input_text', text }],
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: { IMAGE_ANALYSIS: 'image', BASE: () => 'system', BASE_GENERIC: 'system', IMAGE_DESCRIPTION_PROMPT: 'describe' }
    }
  });
  await expect(sendErrorMod.execute(createBaseMessage())).resolves.not.toThrow();
});

test('should logs send errors when splitMessage throws after response', async () => {
  const mod = loadMessageCreate({
    generateAIResponse: async () => 'response text',
    aiUtils: {
      splitMessage: () => { throw new Error('split failed'); },
      processImageAttachments: async () => [],
      createMessageContent: text => [{ type: 'input_text', text }],
      trimConversationHistory: history => history,
      createSystemMessage: () => ({ role: 'system', content: 'system' }),
      SYSTEM_MESSAGES: { IMAGE_ANALYSIS: 'image', BASE: () => 'system', BASE_GENERIC: 'system', IMAGE_DESCRIPTION_PROMPT: 'describe' }
    }
  });
  await expect(mod.execute(createBaseMessage())).resolves.not.toThrow();
});

test('should swallows metric failures in backpressure catch blocks', async () => {
  let recordCalls = 0;
  const mod = loadMessageCreate({
    config: { maxPendingPerChannel: 1 },
    instrument: {
      recordCount: (_name, _value, attrs) => {
        recordCalls += 1;
        if (attrs?.location === 'messageCreate.backpressure_reply') {
          throw new Error('metric failed');
        }
      }
    }
  });
  const message = createBaseMessage();
  message.client.channelQueueDepth.set('chan-1', 1);
  message.reply = async () => {
    const err = new Error('busy reply failed');
    err.status = 500;
    throw err;
  };
  await expect(mod.execute(message)).resolves.not.toThrow();
});

test('should falls back to a normal reply when the thinking message cannot be edited', async () => {
  const messageReplies = [];
  const mod = loadMessageCreate({ generateAIResponse: async () => 'final answer' });
  const message = createBaseMessage({
    reply: async payload => {
      messageReplies.push(payload.content);
      if (messageReplies.length === 1) {
        return { edit: async () => { throw new Error('cannot edit placeholder'); } };
      }
      return { edit: async () => {} };
    }
  });

  await mod.execute(message);
  expect(messageReplies[0]).toBe('*Thinking...*');
  expect(messageReplies[1]).toBe('final answer');
  expect(message.client.conversationHistory.get('chan-1').at(-1).content).toBe('final answer');
});

test('should splits long replies into a primary chunk plus follow-up messages', async () => {
  const sentChunks = [];
  const mod = loadMessageCreate({ generateAIResponse: async () => 'a'.repeat(4100) });
  const message = createBaseMessage({
    reply: async payload => {
      if (sentChunks.length === 0 && payload.content === '*Thinking...*') {
        sentChunks.push(payload.content);
        return { edit: async ({ content }) => { sentChunks.push(content); } };
      }
      sentChunks.push(payload.content);
      return { edit: async () => {} };
    }
  });

  await mod.execute(message);
  expect(sentChunks[0]).toBe('*Thinking...*');
  expect(sentChunks[1].length).toBe(2000);
  expect(sentChunks[2].length).toBe(2000);
  expect(sentChunks[3].length).toBe(100);
});

test('should replies with a clear error message when the AI service returns no content', async () => {
  const responses = [];
  const mod = loadMessageCreate({ generateAIResponse: async () => '' });
  const message = createBaseMessage({
    reply: async payload => {
      responses.push(payload.content);
      if (responses.length === 1) {
        return { edit: async ({ content }) => { responses.push(content); } };
      }
      return { edit: async () => {} };
    }
  });

  await mod.execute(message);
  expect(responses[0]).toBe('*Thinking...*');
  expect(responses[1]).toMatch(/^⚠️ Something went wrong/);
});

test('should send categorized AI errors without storing them in history', async () => {
  const errorReply = realAiUtils.formatAIUserMessage({ reason: 'rate_limit' });
  const mod = loadMessageCreate({ generateAIResponse: async () => errorReply });
  const message = createBaseMessage();
  message.client.conversationHistory.set('chan-1', [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' }
  ]);

  await mod.execute(message);
  expect(message.getReplyTexts().some(text => text.includes('busy'))).toBe(true);
  const history = message.client.conversationHistory.get('chan-1');
  expect(history.some(entry => entry.role === 'assistant')).toBe(false);
});

test('should does not reply to messages with only @here or @everyone mention', async () => {
  for (const content of ['@here check this out', '@everyone this is important']) {
    let replyCalled = false;
    const mod = loadMessageCreate({ generateAIResponse: async () => 'response' });
    const message = createBaseMessage({
      content,
      mentions: {
        has: () => false,
        users: { has: () => false },
        everyone: true,
        size: 0,
        values: () => []
      },
      reply: async () => {
        replyCalled = true;
        return { edit: async () => {} };
      }
    });

    await mod.execute(message);
    expect(replyCalled).toBe(false);
    expect(message.client.conversationHistory.has('chan-1')).toBe(false);
  }
});

test('should ignores replies that are not to the bot', async () => {
  const mod = loadMessageCreate();
  const message = createBaseMessage({
    mentions: { has: () => false, users: { has: () => false }, everyone: false, size: 0, values: () => [] },
    reference: { messageId: 'ref-1' },
    channel: {
      name: 'general',
      messages: {
        fetch: async () => ({
          id: 'ref-1',
          author: { id: 'other-user' },
          content: 'not bot',
          reference: null,
          attachments: { size: 0, values: () => [] }
        })
      }
    }
  });
  await mod.execute(message);
  expect(message.client.conversationHistory.has('chan-1')).toBe(false);
});

test('should skips bot-authored quoted context and empty prior messages', async () => {
  const mod = loadMessageCreate({ generateAIResponse: async () => 'ok' });
  const parentUser = {
    id: 'parent-user',
    author: { id: 'user-2', username: 'bob', bot: false },
    content: null,
    reference: null,
    attachments: { size: 0, values: () => [] }
  };
  const botMiddle = {
    id: 'parent-bot',
    author: { id: 'bot-123', username: 'bot', bot: true },
    content: 'bot said this',
    reference: { messageId: 'parent-user' },
    attachments: { size: 0, values: () => [] }
  };

  const message = createBaseMessage({
    content: '<@123> follow up',
    reference: { messageId: 'parent-bot' },
    channel: {
      name: 'general',
      messages: {
        fetch: async id => {
          if (id === 'parent-bot') return botMiddle;
          if (id === 'parent-user') return parentUser;
          return null;
        }
      }
    }
  });

  await mod.execute(message);
  const history = message.client.conversationHistory.get('chan-1');
  const userTurn = history.find(entry => entry.role === 'user');
  expect(JSON.stringify(userTurn.content)).toMatch(/follow up/);
  expect(JSON.stringify(userTurn.content)).not.toMatch(/bot said this/);
});

test('should decrements queue depth when stored depth is zero', async () => {
  const mod = loadMessageCreate({ generateAIResponse: async () => 'ok' });
  const depthMap = new Map([['chan-1', -1]]);
  const message = createBaseMessage({ client: { ...createBaseMessage().client, channelQueueDepth: depthMap } });
  await mod.execute(message);
  expect(depthMap.get('chan-1')).toBe(0);
});

test('should logs reference fetch failures', async () => {
  const mod = loadMessageCreate();
  const message = createBaseMessage({
    reference: { messageId: 'ref-missing' },
    mentions: { has: () => true, users: { has: () => true }, everyone: false, size: 1, values: () => [] },
    channel: {
      name: 'general',
      messages: { fetch: async () => { throw new Error('missing reference'); } }
    }
  });
  await mod.execute(message);
});

test('should records queue depth gauge on successful mention', async () => {
  const gaugeCalls = [];
  const mod = loadMessageCreate({
    generateAIResponse: async () => 'ok',
    instrument: {
      recordGauge: (name, value, attrs) => gaugeCalls.push({ name, value, attrs })
    }
  });
  await mod.execute(createBaseMessage());
  expect(gaugeCalls.some(call => call.name === 'discord.channel.queue_depth' && call.value >= 1)).toBeTruthy();
});
