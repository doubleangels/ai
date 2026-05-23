const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const tracerPath = path.resolve(__dirname, '..', 'utils', 'replyChainTracer.js');

function loadTracer() {
  delete require.cache[tracerPath];
  return require(tracerPath);
}

function makeMessage({ id, content = 'msg', author = { id: 'u1', username: 'alice', tag: 'alice#1', bot: false }, reference = null, attachments = { size: 0 } }) {
  return {
    id,
    content,
    author,
    reference,
    attachments,
    createdTimestamp: Date.now()
  };
}

test.afterEach(() => {
  const tracer = loadTracer();
  tracer.clearCache();
});

test('clearCache empties the message cache', async () => {
  const tracer = loadTracer();
  const channel = {
    id: 'chan-1',
    messages: {
      fetch: async (messageId) => makeMessage({ id: messageId, content: 'cached' })
    }
  };

  await tracer.fetchMessageCached(channel, 'm1');
  tracer.clearCache();
  let fetchCount = 0;
  channel.messages.fetch = async (messageId) => {
    fetchCount += 1;
    return makeMessage({ id: messageId, content: 'fresh' });
  };

  const msg = await tracer.fetchMessageCached(channel, 'm1');
  assert.equal(fetchCount, 1);
  assert.equal(msg.content, 'fresh');
});

test('fetchMessageCached returns cached message on second call', async () => {
  const tracer = loadTracer();
  let fetchCount = 0;
  const channel = {
    id: 'chan-1',
    messages: {
      fetch: async (messageId) => {
        fetchCount += 1;
        return makeMessage({ id: messageId });
      }
    }
  };

  await tracer.fetchMessageCached(channel, 'm1');
  await tracer.fetchMessageCached(channel, 'm1');
  assert.equal(fetchCount, 1);
});

test('fetchMessageCached returns null when fetch fails', async () => {
  const tracer = loadTracer();
  const channel = {
    id: 'chan-1',
    messages: {
      fetch: async () => {
        throw new Error('not found');
      }
    }
  };

  const result = await tracer.fetchMessageCached(channel, 'missing');
  assert.equal(result, null);
});

test('traceReplyChain returns single message when no reference', async () => {
  const tracer = loadTracer();
  const start = makeMessage({ id: 'm3', content: 'current' });
  const channel = { id: 'chan-1', messages: { fetch: async () => null } };

  const chain = await tracer.traceReplyChain(start, channel);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].id, 'm3');
});

test('traceReplyChain walks parent references oldest to newest', async () => {
  const tracer = loadTracer();
  const parent = makeMessage({ id: 'm1', content: 'oldest' });
  const middle = makeMessage({
    id: 'm2',
    content: 'middle',
    reference: { messageId: 'm1' }
  });
  const start = makeMessage({
    id: 'm3',
    content: 'current',
    reference: { messageId: 'm2' }
  });

  const channel = {
    id: 'chan-1',
    messages: {
      fetch: async (messageId) => {
        if (messageId === 'm2') return middle;
        if (messageId === 'm1') return parent;
        return null;
      }
    }
  };

  const chain = await tracer.traceReplyChain(start, channel);
  assert.deepEqual(chain.map(m => m.id), ['m1', 'm2', 'm3']);
});

test('traceReplyChain stops when parent fetch fails', async () => {
  const tracer = loadTracer();
  const start = makeMessage({
    id: 'm2',
    content: 'current',
    reference: { messageId: 'm1' }
  });
  const channel = {
    id: 'chan-1',
    messages: {
      fetch: async () => {
        throw new Error('gone');
      }
    }
  };

  const chain = await tracer.traceReplyChain(start, channel);
  assert.deepEqual(chain.map(m => m.id), ['m2']);
});

test('traceReplyChain respects MAX_CHAIN_DEPTH', async () => {
  const tracer = loadTracer();
  let depth = 0;
  const channel = {
    id: 'chan-1',
    messages: {
      fetch: async (messageId) => {
        depth += 1;
        return makeMessage({
          id: messageId,
          reference: { messageId: `p-${depth}` }
        });
      }
    }
  };

  const start = makeMessage({ id: 'start', reference: { messageId: 'p-0' } });
  const chain = await tracer.traceReplyChain(start, channel);
  assert.ok(chain.length <= tracer.MAX_CHAIN_DEPTH + 1);
});

test('traceReplyChain returns partial chain on unexpected error', async () => {
  const tracer = loadTracer();
  const badMessage = {
    id: 'bad',
    get reference() {
      throw new Error('boom');
    }
  };
  const channel = { id: 'chan-1', messages: { fetch: async () => null } };

  const chain = await tracer.traceReplyChain(badMessage, channel);
  assert.deepEqual(chain.map(m => m.id), ['bad']);
});

test('traceReplyChain returns start message when traversal fails before building chain', async () => {
  const tracer = loadTracer();
  const startMessage = makeMessage({ id: 'solo', content: 'solo' });
  const channel = { id: 'chan-1', messages: { fetch: async () => null } };
  const originalUnshift = Array.prototype.unshift;

  Array.prototype.unshift = function unshiftThrows() {
    throw new Error('unshift failed');
  };

  try {
    const chain = await tracer.traceReplyChain(startMessage, channel);
    assert.deepEqual(chain.map(m => m.id), ['solo']);
  } finally {
    Array.prototype.unshift = originalUnshift;
  }
});

test('formatChainAsContext returns empty for empty or single-message chains', () => {
  const tracer = loadTracer();
  assert.equal(tracer.formatChainAsContext([]), '');
  assert.equal(tracer.formatChainAsContext([makeMessage({ id: 'm1' })]), '');
});

test('formatChainAsContext uses author tag when username is missing', () => {
  const tracer = loadTracer();
  const chain = [
    makeMessage({ id: 'm1', content: 'hello', author: { tag: 'tagged#1' } }),
    makeMessage({ id: 'm2', content: 'current', author: { username: 'alice' } })
  ];
  const context = tracer.formatChainAsContext(chain);
  assert.match(context, /tagged#1: hello/);
});

test('formatChainAsContext formats prior messages with truncation and mention cleanup', () => {
  const tracer = loadTracer();
  const longContent = 'x'.repeat(250);
  const chain = [
    makeMessage({ id: 'm1', content: `<@123> ${longContent}`, author: { username: 'bob' } }),
    makeMessage({ id: 'm2', content: 'current', author: { username: 'alice' } })
  ];

  const context = tracer.formatChainAsContext(chain);
  assert.match(context, /\[Previous conversation context\]/);
  assert.match(context, /bob: @user/);
  assert.match(context, /\.\.\./);
  assert.match(context, /\[End of context\]/);
});

test('extractChainMessages maps chain metadata', async () => {
  const tracer = loadTracer();
  const chain = [
    makeMessage({
      id: 'm1',
      content: 'hello',
      author: { id: 'u1', username: 'alice', tag: 'alice#1', bot: false },
      attachments: { size: 2 }
    })
  ];

  const rows = await tracer.extractChainMessages(chain);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'm1');
  assert.equal(rows[0].content, 'hello');
  assert.equal(rows[0].author.username, 'alice');
  assert.equal(rows[0].attachments, 2);
  assert.equal(rows[0].isBot, false);
});
