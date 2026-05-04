const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');

const messageCreatePath = path.resolve(__dirname, '..', 'events', 'messageCreate.js');
const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');

function loadMessageCreateWithResponse(generateAIResponse) {
  delete require.cache[messageCreatePath];
  delete require.cache[aiServicePath];

  require.cache[aiServicePath] = {
    id: aiServicePath,
    filename: aiServicePath,
    loaded: true,
    exports: { generateAIResponse }
  };

  return require(messageCreatePath);
}

function createMessage({ replyImpl, editImpl, content = '<@123> hello', channelId = 'chan-1' } = {}) {
  const reply = replyImpl || (async () => ({ edit: editImpl || (async () => {}) }));

  return {
    id: 'msg-1',
    content,
    channelId,
    channel: {
      name: 'general',
      messages: {
        fetch: async () => ({ author: { id: 'bot-123' }, content: 'previous bot reply', reference: null, attachments: { size: 0, values: () => [] } })
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
    author: { bot: false, id: 'user-1', tag: 'User#0001' },
    guildId: 'guild-1',
    mentions: { has: () => true },
    reference: null,
    attachments: new Map(),
    reply
  };
}

test('falls back to a normal reply when the thinking message cannot be edited', async () => {
  const messageReplies = [];
  const module = loadMessageCreateWithResponse(async () => 'final answer');

  const message = createMessage({
    replyImpl: async () => {
      if (messageReplies.length === 0) {
        messageReplies.push('*Thinking...*');
        return {
          edit: async () => {
            throw new Error('cannot edit placeholder');
          }
        };
      }

      messageReplies.push('final answer');
      return { edit: async () => {} };
    }
  });

  await module.execute(message);

  assert.equal(messageReplies.length, 2);
  assert.equal(messageReplies[0], '*Thinking...*');
  assert.equal(messageReplies[1], 'final answer');
  assert.equal(message.client.conversationHistory.get('chan-1').at(-1).content, 'final answer');
});

test('splits long replies into a primary chunk plus follow-up messages', async () => {
  const sentChunks = [];
  const module = loadMessageCreateWithResponse(async () => 'a'.repeat(4100));

  const message = createMessage({
    replyImpl: async (payload) => {
      if (sentChunks.length === 0 && payload.content === '*Thinking...*') {
        sentChunks.push(payload.content);
        return {
          edit: async ({ content }) => {
            sentChunks.push(content);
          }
        };
      }

      sentChunks.push(payload.content);
      return { edit: async () => {} };
    }
  });

  await module.execute(message);

  assert.equal(sentChunks[0], '*Thinking...*');
  assert.equal(sentChunks[1].length, 2000);
  assert.equal(sentChunks[2].length, 2000);
  assert.equal(sentChunks[3].length, 100);
  assert.equal(message.client.conversationHistory.get('chan-1').at(-1).content.length, 4100);
});

test('replies with a clear error message when the AI service returns no content', async () => {
  const responses = [];
  const module = loadMessageCreateWithResponse(async () => '');

  const message = createMessage({
    replyImpl: async (payload) => {
      responses.push(payload.content);
      if (responses.length === 1) {
        return {
          edit: async ({ content }) => {
            responses.push(content);
          }
        };
      }

      return { edit: async () => {} };
    }
  });

  await module.execute(message);

  assert.equal(responses[0], '*Thinking...*');
  assert.equal(responses[1], "⚠️ I couldn't generate a response.");
  assert.equal(message.client.conversationHistory.get('chan-1').at(-1).role, 'user');
  assert.deepEqual(message.client.conversationHistory.get('chan-1').at(-1).content, [
    {
      type: 'input_text',
      text: '<@123> hello'
    }
  ]);
});
