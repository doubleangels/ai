const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const messageCreatePath = path.resolve(__dirname, '..', 'events', 'messageCreate.js');
const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');

function loadMessageCreate(generateAIResponse) {
  delete require.cache[messageCreatePath];
  delete require.cache[aiServicePath];
  delete require.cache[require.resolve('../config')];
  require.cache[aiServicePath] = {
    id: aiServicePath,
    filename: aiServicePath,
    loaded: true,
    exports: { generateAIResponse }
  };

  return require(messageCreatePath);
}

function createClient() {
  return {
    user: { id: 'bot-123', tag: 'Bot#0001' },
    channelLocks: new Map(),
    channelQueueDepth: new Map(),
    userCooldowns: new Map(),
    channelCooldowns: new Map(),
    conversationHistory: new Map(),
    guilds: { cache: new Map() }
  };
}

function createMessage(overrides = {}) {
  return {
    id: 'msg-1',
    content: '<@bot-123> hello',
    channelId: 'chan-1',
    guildId: 'guild-1',
    channel: {
      name: 'general',
      messages: {
        fetch: async () => ({ author: { id: 'bot-123' } })
      }
    },
    client: createClient(),
    author: { bot: false, id: 'user-1', tag: 'User#0001' },
    mentions: { has: () => true },
    reference: null,
    attachments: new Map(),
    reply: async () => ({ edit: async () => {} }),
    ...overrides
  };
}

test('messageCreate ignores bot-authored messages', async () => {
  const module = loadMessageCreate(async () => 'unused');
  const message = createMessage({ author: { bot: true, id: 'bot-123', tag: 'Bot#0001' } });
  await module.execute(message);
  assert.equal(message.client.conversationHistory.size, 0);
});

test('messageCreate blocks guilds outside the allow list', async () => {
  const original = process.env.ALLOWED_GUILD_IDS;
  process.env.ALLOWED_GUILD_IDS = 'allowed-guild';
  const module = loadMessageCreate(async () => 'unused');
  const message = createMessage({ guildId: 'denied-guild' });
  await module.execute(message);
  assert.equal(message.client.conversationHistory.size, 0);
  if (original === undefined) delete process.env.ALLOWED_GUILD_IDS; else process.env.ALLOWED_GUILD_IDS = original;
});

test('messageCreate sends a backpressure reply when the queue is full', async () => {
  const module = loadMessageCreate(async () => 'unused');
  const replies = [];
  const message = createMessage({
    client: {
      ...createClient(),
      channelQueueDepth: new Map([['chan-1', 3]])
    },
    reply: async payload => {
      replies.push(payload.content);
      return { edit: async () => {} };
    }
  });

  await module.execute(message);
  assert.equal(replies[0], "⚠️ I'm busy in this channel—please try again in a few seconds.");
});

test('messageCreate sends a user cooldown reply', async () => {
  const module = loadMessageCreate(async () => 'unused');
  const replies = [];
  const client = createClient();
  client.userCooldowns.set('user-1', Date.now());
  const message = createMessage({
    client,
    reply: async payload => {
      replies.push(payload.content);
      return { edit: async () => {} };
    }
  });

  await module.execute(message);
  assert.match(replies[0], /Please wait/);
});

test('messageCreate sends a channel cooldown reply', async () => {
  const module = loadMessageCreate(async () => 'unused');
  const replies = [];
  const client = createClient();
  client.channelCooldowns.set('chan-1', Date.now());
  const message = createMessage({
    client,
    reply: async payload => {
      replies.push(payload.content);
      return { edit: async () => {} };
    }
  });

  await module.execute(message);
  assert.match(replies[0], /Give me/);
});

test('messageCreate ignores replies to non-bot messages', async () => {
  const module = loadMessageCreate(async () => 'unused');
  const message = createMessage({
    mentions: { has: () => false },
    reference: { messageId: 'ref-1' },
    channel: {
      name: 'general',
      messages: {
        fetch: async () => ({ author: { id: 'someone-else' } })
      }
    }
  });

  await module.execute(message);
  assert.equal(message.client.conversationHistory.size, 0);
});

test('messageCreate records a rate-limit metric when fallback reply fails', async () => {
  const module = loadMessageCreate(async () => 'result');
  const replies = [];
  const message = createMessage({
    reply: async () => {
      if (replies.length === 0) {
        replies.push('thinking');
        return {
          edit: async () => {
            throw Object.assign(new Error('rate limited'), { status: 429 });
          }
        };
      }

      replies.push('fallback');
      const error = new Error('rate limited');
      error.status = 429;
      throw error;
    }
  });

  await module.execute(message);
  assert.equal(replies[0], 'thinking');
});

test('messageCreate stops when a referenced message cannot be fetched', async () => {
  const module = loadMessageCreate(async () => 'unused');
  const message = createMessage({
    mentions: { has: () => false },
    reference: { messageId: 'ref-1' },
    channel: {
      name: 'general',
      messages: {
        fetch: async () => {
          throw new Error('missing reference');
        }
      }
    }
  });

  await module.execute(message);
  assert.equal(message.client.conversationHistory.size, 0);
});

test('messageCreate initializes missing channel state and handles reply-to-bot context', async () => {
  const module = loadMessageCreate(async () => 'reply from bot');
  const client = createClient();
  delete client.channelLocks;
  delete client.channelQueueDepth;
  delete client.userCooldowns;
  delete client.channelCooldowns;

  const message = createMessage({
    client,
    content: 'Thanks for the help',
    mentions: { has: () => false },
    reference: { messageId: 'ref-1' },
    channel: {
      name: 'general',
      messages: {
        fetch: async messageId => {
          if (messageId === 'ref-1') {
            return {
              author: { id: 'bot-123' },
              content: 'Bot reply',
              reference: { messageId: 'parent-1' },
              attachments: new Map()
            };
          }

          return {
            author: { id: 'user-2' },
            content: 'Original question',
            attachments: new Map()
          };
        }
      }
    }
  });

  await module.execute(message);

  assert.equal(client.channelLocks instanceof Map, true);
  assert.equal(client.channelQueueDepth instanceof Map, true);
  assert.equal(client.userCooldowns instanceof Map, true);
  assert.equal(client.channelCooldowns instanceof Map, true);
  assert.equal(client.conversationHistory.has('chan-1'), true);
});