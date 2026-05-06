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
    mentions: { 
      has: () => true,
      everyone: false,
      size: 1,
      values: () => [{ id: '123' }]
    },
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

test('does not reply to messages with only @here mention', async () => {
  let replyCalled = false;
  const module = loadMessageCreateWithResponse(async () => 'response');

  const message = createMessage({
    content: '@here check this out',
    replyImpl: async () => {
      replyCalled = true;
      return { edit: async () => {} };
    }
  });

  // Override mentions to simulate @here without bot mention
  message.mentions.has = () => false;
  message.mentions.everyone = true;
  message.mentions.size = 0;
  message.mentions.values = () => [];
  // --- appended from test/messageCreate.coverage.test.js ---
  function loadMessageCreate(generateAIResponse) {
    const messageCreatePath = path.resolve(__dirname, '..', 'events', 'messageCreate.js');
    const aiServicePath = path.resolve(__dirname, '..', 'utils', 'aiService.js');
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


  await module.execute(message);

  assert.equal(replyCalled, false, 'Bot should not reply to @here-only messages');
  assert.equal(message.client.conversationHistory.get('chan-1'), undefined, 'No conversation history should be created');
});

test('does not reply to messages with only @everyone mention', async () => {
  let replyCalled = false;
  const module = loadMessageCreateWithResponse(async () => 'response');

  const message = createMessage({
    content: '@everyone this is important',
    replyImpl: async () => {
      replyCalled = true;
      return { edit: async () => {} };
    }
  });

  // Override mentions to simulate @everyone without bot mention
  message.mentions.has = () => false;
  message.mentions.everyone = true;
  message.mentions.size = 0;
  message.mentions.values = () => [];

  await module.execute(message);

  assert.equal(replyCalled, false, 'Bot should not reply to @everyone-only messages');
  assert.equal(message.client.conversationHistory.get('chan-1'), undefined, 'No conversation history should be created');
});

test('processes image attachments from messages', async () => {
  const https = require('https');
  const { EventEmitter } = require('node:events');
  function withHttpsStub(handler, run) {
    const originalGet = https.get;
    https.get = handler;
    return Promise.resolve()
      .then(run)
      .finally(() => { https.get = originalGet; });
  }

  const module = loadMessageCreateWithResponse(async () => 'analyzed');

  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'image/png', 'content-length': '4' };
      response.resume = () => {};
      process.nextTick(() => {
        response.emit('data', Buffer.from('test'));
        response.emit('end');
      });
      callback(response);
    });
    return request;
  }, async () => {
    const attachment = { url: 'https://cdn.discordapp.com/test.png', contentType: 'image/png', name: 'test.png' };

    const message = createMessage({ replyImpl: async (payload) => {
      if (payload.content === '*Thinking...*') return { edit: async ({ content }) => {} };
      return { edit: async () => {} };
    } });

    message.attachments = new Map([['att-1', attachment]]);

    await module.execute(message);
    assert.ok(message.client.conversationHistory.has('chan-1'));
  });
});

test('handles multiple attachments in a single message', async () => {
  const module = loadMessageCreateWithResponse(async () => 'processed');

  const message = createMessage({ replyImpl: async () => ({ edit: async () => {} }) });

  const attachment1 = { url: 'https://cdn.discordapp.com/image1.png', contentType: 'image/png', name: 'image1.png' };
  const attachment2 = { url: 'https://cdn.discordapp.com/image2.png', contentType: 'image/jpeg', name: 'image2.jpg' };

  message.attachments = new Map([['att-1', attachment1], ['att-2', attachment2]]);

  await module.execute(message);
  assert.ok(message.client.conversationHistory.has('chan-1'));
  const history = message.client.conversationHistory.get('chan-1');
  assert.ok(history.length > 0);
});
