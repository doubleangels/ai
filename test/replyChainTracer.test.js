const path = require('path');
const { reloadModule } = require('./testUtils.cjs');

const tracerPath = path.resolve(__dirname, '..', 'utils', 'replyChainTracer.js');
const configPath = path.resolve(__dirname, '..', 'config.js');

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

afterEach(() => {
  const tracer = loadTracer();
  tracer.clearCache();
});

test('should empties the message cache', async () => {
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
  expect(fetchCount).toBe(1);
  expect(msg.content).toBe('fresh');
});

test('should fetchMessageCached returns cached message on second call', async () => {
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
  expect(fetchCount).toBe(1);
});

test('should fetchMessageCached returns null when fetch fails', async () => {
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
  expect(result).toBe(null);
});

test('should traceReplyChain returns single message when no reference', async () => {
  const tracer = loadTracer();
  const start = makeMessage({ id: 'm3', content: 'current' });
  const channel = { id: 'chan-1', messages: { fetch: async () => null } };

  const chain = await tracer.traceReplyChain(start, channel);
  expect(chain.length).toBe(1);
  expect(chain[0].id).toBe('m3');
});

test('should traceReplyChain walks parent references oldest to newest', async () => {
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
  expect(chain.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
});

test('should traceReplyChain stops when parent fetch fails', async () => {
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
  expect(chain.map(m => m.id)).toEqual(['m2']);
});

test('should traceReplyChain respects maxDepth parameter', async () => {
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
  const chain = await tracer.traceReplyChain(start, channel, 5);
  expect(chain.length <= 6).toBeTruthy();
});

test('should traceReplyChain returns partial chain on unexpected error', async () => {
  const tracer = loadTracer();
  const badMessage = {
    id: 'bad',
    get reference() {
      throw new Error('boom');
    }
  };
  const channel = { id: 'chan-1', messages: { fetch: async () => null } };

  const chain = await tracer.traceReplyChain(badMessage, channel);
  expect(chain.map(m => m.id)).toEqual(['bad']);
});

test('should traceReplyChain returns start message when traversal fails before building chain', async () => {
  const tracer = loadTracer();
  const startMessage = makeMessage({ id: 'solo', content: 'solo' });
  const channel = { id: 'chan-1', messages: { fetch: async () => null } };
  const originalUnshift = Array.prototype.unshift;

  Array.prototype.unshift = function unshiftThrows() {
    throw new Error('unshift failed');
  };

  try {
    const chain = await tracer.traceReplyChain(startMessage, channel);
    expect(chain.map(m => m.id)).toEqual(['solo']);
  } finally {
    Array.prototype.unshift = originalUnshift;
  }
});

test('should formatChainAsContext returns empty for empty or single-message chains', () => {
  const tracer = loadTracer();
  expect(tracer.formatChainAsContext([])).toBe('');
  expect(tracer.formatChainAsContext([makeMessage({ id: 'm1' })])).toBe('');
});

test('should formatChainAsContext uses author tag when username is missing', () => {
  const tracer = loadTracer();
  const chain = [
    makeMessage({ id: 'm1', content: 'hello', author: { tag: 'tagged#1' } }),
    makeMessage({ id: 'm2', content: 'current', author: { username: 'alice' } })
  ];
  const context = tracer.formatChainAsContext(chain);
  expect(context).toMatch(/tagged#1: hello/);
});

test('should formatChainAsContext formats prior messages with truncation and mention cleanup', () => {
  const tracer = loadTracer();
  const longContent = 'x'.repeat(250);
  const chain = [
    makeMessage({ id: 'm1', content: `<@123> ${longContent}`, author: { username: 'bob' } }),
    makeMessage({ id: 'm2', content: 'current', author: { username: 'alice' } })
  ];

  const context = tracer.formatChainAsContext(chain);
  expect(context).toMatch(/\[Previous conversation context\]/);
  expect(context).toMatch(/bob: @user/);
  expect(context).toMatch(/\.\.\./);
  expect(context).toMatch(/\[End of context\]/);
});

test('should extractChainMessages maps chain metadata', async () => {
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
  expect(rows.length).toBe(1);
  expect(rows[0].id).toBe('m1');
  expect(rows[0].content).toBe('hello');
  expect(rows[0].author.username).toBe('alice');
  expect(rows[0].attachments).toBe(2);
  expect(rows[0].isBot).toBe(false);
});

test('should fetchMessageCached refetches after TTL expiry', async () => {
  jest.useFakeTimers();
  const savedTtl = process.env.MESSAGE_CACHE_TTL_MS;
  process.env.MESSAGE_CACHE_TTL_MS = '60000';

  const tracer = reloadModule(tracerPath, () => {
    delete require.cache[configPath];
  });
  tracer.clearCache();

  let fetchCount = 0;
  const channel = {
    id: 'chan-1',
    messages: {
      fetch: async (messageId) => {
        fetchCount += 1;
        return makeMessage({ id: messageId, content: `v${fetchCount}` });
      }
    }
  };

  try {
    await tracer.fetchMessageCached(channel, 'm1');
    jest.advanceTimersByTime(60_001);
    const msg = await tracer.fetchMessageCached(channel, 'm1');
    expect(fetchCount).toBe(2);
    expect(msg.content).toBe('v2');
  } finally {
    jest.useRealTimers();
    if (savedTtl === undefined) delete process.env.MESSAGE_CACHE_TTL_MS;
    else process.env.MESSAGE_CACHE_TTL_MS = savedTtl;
    delete require.cache[configPath];
    delete require.cache[tracerPath];
  }
});

test('should fetchMessageCached evicts oldest entries at max size', async () => {
  const savedMax = process.env.MESSAGE_CACHE_MAX_SIZE;
  process.env.MESSAGE_CACHE_MAX_SIZE = '10';

  const tracer = reloadModule(tracerPath, () => {
    delete require.cache[configPath];
  });
  tracer.clearCache();

  const fetchCounts = new Map();
  const channel = {
    id: 'chan-1',
    messages: {
      fetch: async (messageId) => {
        fetchCounts.set(messageId, (fetchCounts.get(messageId) || 0) + 1);
        return makeMessage({ id: messageId, content: messageId });
      }
    }
  };

  try {
    for (let i = 1; i <= 11; i++) {
      await tracer.fetchMessageCached(channel, `m${i}`);
    }
    await tracer.fetchMessageCached(channel, 'm1');
    expect(fetchCounts.get('m1')).toBe(2);
    expect(fetchCounts.get('m11')).toBe(1);
  } finally {
    if (savedMax === undefined) delete process.env.MESSAGE_CACHE_MAX_SIZE;
    else process.env.MESSAGE_CACHE_MAX_SIZE = savedMax;
    delete require.cache[configPath];
    delete require.cache[tracerPath];
  }
});

test('should trimMessageCache removes expired entries on insert', async () => {
  jest.useFakeTimers();
  const savedTtl = process.env.MESSAGE_CACHE_TTL_MS;
  process.env.MESSAGE_CACHE_TTL_MS = '60000';

  const tracer = reloadModule(tracerPath, () => {
    delete require.cache[configPath];
  });
  tracer.clearCache();

  const channel = {
    id: 'chan-1',
    messages: {
      fetch: async (messageId) => makeMessage({ id: messageId })
    }
  };

  try {
    await tracer.fetchMessageCached(channel, 'm1');
    jest.advanceTimersByTime(60_001);
    await tracer.fetchMessageCached(channel, 'm2');
    let fetchCount = 0;
    channel.messages.fetch = async (messageId) => {
      fetchCount += 1;
      return makeMessage({ id: messageId });
    };
    await tracer.fetchMessageCached(channel, 'm1');
    expect(fetchCount).toBe(1);
  } finally {
    jest.useRealTimers();
    if (savedTtl === undefined) delete process.env.MESSAGE_CACHE_TTL_MS;
    else process.env.MESSAGE_CACHE_TTL_MS = savedTtl;
    delete require.cache[configPath];
    delete require.cache[tracerPath];
  }
});

test('should exports DEFAULT_MAX_CHAIN_DEPTH', () => {
  const tracer = loadTracer();
  expect(tracer.DEFAULT_MAX_CHAIN_DEPTH).toBe(15);
});
