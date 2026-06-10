const path = require('path');

const aiUtils = require(path.resolve(__dirname, '..', '..', 'utils', 'aiUtils.js'));

test('should splitMessage returns empty array for empty input', () => {
  const parts = aiUtils.splitMessage('', 2000);
  expect(parts).toEqual([]);
});

test('should splitMessage does not split short text', () => {
  const text = 'hello world';
  const parts = aiUtils.splitMessage(text, 2000);
  expect(parts.length).toBe(1);
  expect(parts[0]).toBe(text);
});

test('should createMessageContent includes text and images', () => {
  const imgs = [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }];
  const res = aiUtils.createMessageContent(' hi ', imgs);
  expect(res.length).toBe(2);
  expect(res[0].type).toBe('input_text');
  expect(res[0].text).toBe('hi');
  expect(res[1].type).toBe('input_image');
});

test('should hasImages detects images in conversation', () => {
  const conv = [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:' }] }];
  expect(aiUtils.hasImages(conv)).toBe(true);
});

test('should estimateTokensFromText basic heuristic', () => {
  expect(aiUtils.estimateTokensFromText('abcd')).toBe(1);
  expect(aiUtils.estimateTokensFromText('abcdefgh')).toBe(2);
});

// estimateMessageTokens is internal and not exported; validate estimateTokensFromText instead

test('should estimateTokensFromText behaves reasonably', () => {
  expect(aiUtils.estimateTokensFromText('a'.repeat(4))).toBe(1);
  expect(aiUtils.estimateTokensFromText('a'.repeat(8))).toBe(2);
});

test('should preserves system message and trims by length', () => {
  const history = [ { role: 'system', content: 'sys' } ];
  for (let i = 0; i < 10; i++) history.push({ role: 'user', content: `m${i}` });
  aiUtils.trimConversationHistory(history, 3, 0);
  expect(history[0].role).toBe('system');
  expect(history.length).toBeLessThanOrEqual(4);
});

test('should createSystemMessage respects includeModelInPrompt flag', () => {
  const sys = aiUtils.createSystemMessage('model-x', true);
  expect(sys.role).toBe('system');
  expect(typeof sys.content).toBe('string');
  const sys2 = aiUtils.createSystemMessage('model-x', false);
  expect(sys2.role).toBe('system');
});

test('should assertDiscordImageDownloadUrl rejects non-https and invalid hosts', () => {
  expect(() => aiUtils.assertDiscordImageDownloadUrl('http://example.com/img.png')).toThrow();
  expect(() => aiUtils.assertDiscordImageDownloadUrl('https://evil.com/img.png')).toThrow();
});

// --- appended from test/aiUtils.coverage.test.js ---
const { EventEmitter } = require('node:events');
const https = require('https');

function withHttpsStub(handler, run) {
  const originalGet = https.get;
  https.get = handler;

  return Promise.resolve()
    .then(run)
    .finally(() => {
      https.get = originalGet;
    });
}

function createResponse(statusCode, headers, bodyChunks = []) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.headers = headers;
  response.resume = () => {};

  queueMicrotask(() => {
    for (const chunk of bodyChunks) {
      response.emit('data', Buffer.from(chunk));
    }
    response.emit('end');
  });

  return response;
}

test('should downloads a Discord CDN image (coverage merged)', async () => {
  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => callback(createResponse(200, {
      'content-type': 'image/png',
      'content-length': '4'
    }, ['test'])));
    return request;
  }, async () => {
    const result = await aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png');
    expect(result).toMatch(/^data:image\/png;base64/);
  });
});

test('should follows a redirect and rejects unsupported content types (coverage merged)', async () => {
  const calls = [];
  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    calls.push(url);

    queueMicrotask(() => {
      if (calls.length === 1) {
        callback(createResponse(302, { location: 'https://media.discordapp.net/next.png' }));
        return;
      }

      callback(createResponse(200, {
        'content-type': 'text/plain',
        'content-length': '4'
      }, ['test']));
    });

    return request;
  }, async () => {
    await expect(aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png')).rejects.toThrow(/Unsupported content-type/);
    expect(calls.length).toBe(2);
  });
});

test('should processImageAttachments keeps image order and skips non-image attachments (coverage merged)', async () => {
  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);

    queueMicrotask(() => {
      callback(createResponse(200, {
        'content-type': 'image/png',
        'content-length': '4'
      }, [url.includes('one') ? 'one1' : 'two2']));
    });

    return request;
  }, async () => {
    const attachments = [
      { contentType: 'text/plain', url: 'https://cdn.discordapp.com/skip.txt' },
      { contentType: 'image/png', url: 'https://cdn.discordapp.com/one.png', filename: 'one.png' },
      { contentType: 'image/png', url: 'https://cdn.discordapp.com/two.png', filename: 'two.png' }
    ];

    const processed = await aiUtils.processImageAttachments(attachments);
    expect(processed.length).toBe(2);
    expect(processed[0].type).toBe('input_image');
    expect(processed[1].type).toBe('input_image');
    expect(processed[0].image_url).not.toBe(processed[1].image_url);
  });
});

test('should applies the token cap (coverage merged)', () => {
  const history = [{ role: 'system', content: 'sys' }];
  for (let index = 0; index < 6; index += 1) {
    history.push({
      role: 'user',
      content: [
        { type: 'input_text', text: 'a'.repeat(100) },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
      ]
    });
  }

  const originalLength = history.length;
  const trimmed = aiUtils.trimConversationHistory(history, 4, 500);
  expect(trimmed[0].role).toBe('system');
  expect(trimmed.length < originalLength).toBe(true);
});

test('should splitMessage splits on paragraph boundaries and handles failures (coverage merged)', () => {
  const paragraphText = `${'a'.repeat(850)}\n\n${'b'.repeat(500)}`;
  const chunks = aiUtils.splitMessage(paragraphText, 800);
  expect(chunks.length >= 2).toBe(true);

  const badText = {
    length: 900,
    substring: () => {
      throw new Error('substring failed');
    },
    trim: () => 'broken',
    replace: () => 'broken',
    indexOf: () => -1,
    map: Array.prototype.map
  };
  const fallback = aiUtils.splitMessage(badText, 100);
  expect(fallback).toEqual(['Error splitting message']);
});

test('should rejects invalid URLs, redirects, and oversized images (coverage merged)', async () => {
  await expect(aiUtils.downloadImageAsBase64('not-a-url')).rejects.toThrow(/Invalid image URL/);

  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => callback(createResponse(404, { 'content-type': 'image/png' }, [])));
    return request;
  }, async () => {
    await expect(aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png')).rejects.toThrow(/HTTP 404/);
  });

  let redirectCount = 0;
  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    redirectCount += 1;
    queueMicrotask(() => callback(createResponse(302, { location: 'https://cdn.discordapp.com/redirect.png' }, [])));
    return request;
  }, async () => {
    await expect(aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png')).rejects.toThrow(/Too many redirects/);
    expect(redirectCount >= 4).toBe(true);
  });

  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => callback(createResponse(200, {
      'content-type': 'image/png',
      'content-length': '999999999'
    }, [])));
    return request;
  }, async () => {
    await expect(aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png')).rejects.toThrow(/exceeds max size/);
  });
});

test('should splitMessage splits on sentence and word boundaries', () => {
  const sentenceText = `${'a'.repeat(550)}. ${'b'.repeat(300)}`;
  const sentenceChunks = aiUtils.splitMessage(sentenceText, 800);
  expect(sentenceChunks.length >= 2).toBe(true);

  const wordText = `${'a'.repeat(500)} ${'b'.repeat(300)}`;
  const wordChunks = aiUtils.splitMessage(wordText, 800);
  expect(wordChunks.length >= 2).toBe(true);

  const newlineText = `${'a'.repeat(700)}\n${'b'.repeat(200)}`;
  const newlineChunks = aiUtils.splitMessage(newlineText, 800);
  expect(newlineChunks.length >= 2).toBe(true);

  const paragraphText = `${'a'.repeat(650)}\n\n${'b'.repeat(200)}`;
  const paragraphChunks = aiUtils.splitMessage(paragraphText, 800);
  expect(paragraphChunks.length >= 2).toBe(true);
});

test('should handles request timeout and network errors', async () => {
  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = (_ms, handler) => queueMicrotask(() => handler());
    request.destroy = error => request.emit('error', error);
    return request;
  }, async () => {
    await expect(aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png')).rejects.toThrow(/timed out/);
  });

  await withHttpsStub(() => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => request.emit('error', new Error('network down')));
    return request;
  }, async () => {
    await expect(aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png')).rejects.toThrow(/network down/);
  });
});

test('should rejects oversized streamed payloads', async () => {
  const aiUtilsPath = path.resolve(__dirname, '..', '..', 'utils', 'aiUtils.js');
  const configPath = path.resolve(__dirname, '..', '..', 'config.js');
  const savedMax = process.env.MAX_IMAGE_BYTES;
  process.env.MAX_IMAGE_BYTES = '8';
  delete require.cache[aiUtilsPath];
  delete require.cache[configPath];
  const smallLimitUtils = require(aiUtilsPath);

  try {
    await withHttpsStub((url, callback) => {
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = error => request.emit('error', error);
      queueMicrotask(() => {
        callback(createResponse(200, { 'content-type': 'image/png' }, ['0123456789', '0123456789']));
      });
      return request;
    }, async () => {
      await expect(smallLimitUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png')).rejects.toThrow(/exceeds max size/);
    });
  } finally {
    if (savedMax === undefined) delete process.env.MAX_IMAGE_BYTES;
    else process.env.MAX_IMAGE_BYTES = savedMax;
    delete require.cache[aiUtilsPath];
    delete require.cache[configPath];
  }
});

test('should processImageAttachments handles non-array input and attachment label fallbacks', async () => {
  expect(await aiUtils.processImageAttachments(null)).toEqual([]);
  expect(await aiUtils.processImageAttachments('not-an-array')).toEqual([]);

  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => callback(createResponse(200, {
      'content-type': 'image/png',
      'content-length': '4'
    }, ['test'])));
    return request;
  }, async () => {
    const urlOnly = await aiUtils.processImageAttachments([
      { contentType: 'image/png', url: 'https://cdn.discordapp.com/by-url.png' }
    ]);
    expect(urlOnly.length).toBe(1);

    const nameOnly = await aiUtils.processImageAttachments([
      { contentType: 'image/png', name: 'named.png', url: 'https://cdn.discordapp.com/by-name.png' }
    ]);
    expect(nameOnly.length).toBe(1);

    const filenameOnly = await aiUtils.processImageAttachments([
      { contentType: 'image/png', filename: 'file.png', url: 'https://cdn.discordapp.com/by-filename.png' }
    ]);
    expect(filenameOnly.length).toBe(1);

    const emptyNameUsesFilename = await aiUtils.processImageAttachments([
      { contentType: 'image/png', name: '', filename: 'fallback.png', url: 'https://cdn.discordapp.com/fallback.png' }
    ]);
    expect(emptyNameUsesFilename.length).toBe(1);

    const unknownLabel = await aiUtils.processImageAttachments([
      { contentType: 'image/png' }
    ]);
    expect(unknownLabel.length).toBe(0);
  });
});

test('should treats missing statusCode as zero', async () => {
  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.headers = { 'content-type': 'image/png', 'content-length': '4' };
      response.resume = () => {};
      callback(response);
    });
    return request;
  }, async () => {
    await expect(aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png')).rejects.toThrow(/HTTP 0/);
  });
});

test('should token trimming handles null messages and non-array content', () => {
  const history = [
    { role: 'system', content: 'sys' },
    null,
    { role: 'user', content: null },
    { role: 'user', content: { not: 'array' } },
    { role: 'user', content: 'a'.repeat(400) }
  ];
  aiUtils.trimConversationHistory(history, 10, 1);
  expect(history[0].role).toBe('system');
});

test('should rejects redirect targets with invalid hosts', async () => {
  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => callback(createResponse(302, { location: 'https://evil.example/redirect.png' })));
    return request;
  }, async () => {
    await expect(aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png')).rejects.toThrow(/Discord CDN/);
  });
});

test('should uses default reply char budget when maxOutputTokens is invalid', () => {
  const configPath = path.resolve(__dirname, '..', '..', 'config.js');
  const { stubModule, reloadModule } = require('../testUtils.cjs');
  const aiUtilsInvalid = reloadModule(path.resolve(__dirname, '..', '..', 'utils', 'aiUtils.js'), () => {
    stubModule(configPath, {
      maxOutputTokens: 'invalid',
      imageDownloadTimeoutMs: 8000,
      maxImageBytes: 6_000_000
    });
  });

  expect(aiUtilsInvalid.SYSTEM_MESSAGES.BASE('gpt-5.4-nano')).toMatch(/800 characters/);
});

test('should SYSTEM_MESSAGES BASE includes TLDR format guidance', () => {
  const prompt = aiUtils.SYSTEM_MESSAGES.BASE('gpt-5.4-nano');
  expect(prompt).toMatch(/TLDR/i);
  expect(prompt).toMatch(/1–3 short sentences/);
});

test('should pruneChannelAuxMaps removes idle lock and queue entries', () => {
  aiUtils.pruneChannelAuxMaps('', new Map(), new Map());

  const locks = new Map([['chan-1', Promise.resolve()]]);
  const queue = new Map([['chan-1', 0], ['chan-2', 2]]);

  aiUtils.pruneChannelAuxMaps('chan-1', locks, queue, new Map([['chan-1', 'guild-1']]));
  expect(locks.has('chan-1')).toBe(false);
  expect(queue.has('chan-1')).toBe(false);

  const guildIds = new Map([['chan-1', 'guild-1']]);
  locks.set('chan-1', Promise.resolve());
  queue.set('chan-1', 0);
  aiUtils.pruneChannelAuxMaps('chan-1', locks, queue, guildIds);
  expect(guildIds.has('chan-1')).toBe(false);
  expect(queue.has('chan-2')).toBe(true);

  aiUtils.pruneChannelAuxMaps('chan-2', locks, queue, guildIds);
  expect(queue.has('chan-2')).toBe(true);
});

test('should mergeMessageContent adds text to image-only user arrays', () => {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,OLD' }] },
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,NEW' }] }
  ];
  aiUtils.normalizeConversationRoles(history);
  expect(history[1].content.length).toBeGreaterThan(1);
  expect(history[1].content.some(part => part.type === 'input_image')).toBe(true);
});

test('should mergeMessageContent merges plain string user turns', () => {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' }
  ];
  aiUtils.normalizeConversationRoles(history);
  expect(history.length).toBe(2);
  expect(history[1].content).toBe('one\n\ntwo');
});

test('should mergeMessageContent merges string and array user content via normalize', () => {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,OLD' }] },
    { role: 'user', content: 'follow up' }
  ];
  aiUtils.normalizeConversationRoles(history);
  expect(history.length).toBe(2);
  expect(history[1].content.some(part => part.type === 'input_image')).toBe(true);
  expect(history[1].content.some(part => part.type === 'input_text' && part.text.includes('follow up'))).toBe(true);
});

test('should normalizeConversationRoles merges only trailing consecutive user turns', () => {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
    { role: 'user', content: 'third' }
  ];
  aiUtils.normalizeConversationRoles(history);
  expect(history.length).toBe(4);
  expect(history[1].content).toBe('first');
  expect(history[3].content).toContain('second');
  expect(history[3].content).toContain('third');
});

test('should pruneConversationHistories evicts idle channels and enforces max channel count', () => {
  const history = new Map([
    ['chan-old', [{ role: 'system', content: 's' }]],
    ['chan-mid', [{ role: 'system', content: 's' }]],
    ['chan-new', [{ role: 'system', content: 's' }]]
  ]);
  const activity = new Map([
    ['chan-old', Date.now() - 100_000],
    ['chan-mid', Date.now() - 50_000],
    ['chan-new', Date.now()]
  ]);

  aiUtils.pruneConversationHistories(history, activity, 0, 60_000);
  expect(history.has('chan-old')).toBe(false);
  expect(history.has('chan-mid')).toBe(true);
  expect(history.has('chan-new')).toBe(true);

  aiUtils.pruneConversationHistories(history, activity, 1, 0);
  expect(history.size).toBe(1);
  expect(history.has('chan-new')).toBe(true);

  aiUtils.pruneConversationHistories(null, activity, 10, 0);

  const orphanHistory = new Map([['orphan', [{ role: 'system', content: 's' }]]]);
  const sparseActivity = new Map();
  aiUtils.pruneConversationHistories(orphanHistory, sparseActivity, 0, 1000);
  expect(orphanHistory.has('orphan')).toBe(false);

  const stuckHistory = new Map([['stuck', []]]);
  stuckHistory.keys = function keys() {
    return [][Symbol.iterator]();
  };
  Object.defineProperty(stuckHistory, 'size', { value: 2, configurable: true });
  const stuckActivity = new Map([['stuck', 1]]);
  aiUtils.pruneConversationHistories(stuckHistory, stuckActivity, 1, 0);
  expect(stuckHistory.size).toBe(2);

  const capHistory = new Map([
    ['a', []],
    ['b', []]
  ]);
  const capActivity = new Map([
    ['a', 100],
    ['b', 200]
  ]);
  aiUtils.pruneConversationHistories(capHistory, capActivity, 1, 0);
  expect(capHistory.has('a')).toBe(false);
  expect(capHistory.has('b')).toBe(true);

  aiUtils.pruneConversationHistories(capHistory, null, 10, 0);

  const partialActivityHistory = new Map([
    ['tracked', []],
    ['untracked', []]
  ]);
  const partialActivity = new Map([['tracked', 500]]);
  aiUtils.pruneConversationHistories(partialActivityHistory, partialActivity, 1, 0);
  expect(partialActivityHistory.has('untracked')).toBe(false);
  expect(partialActivityHistory.has('tracked')).toBe(true);

  const auxHistory = new Map([
    ['chan-old', [{ role: 'system', content: 's' }]],
    ['chan-new', [{ role: 'system', content: 's' }]]
  ]);
  const auxActivity = new Map([
    ['chan-old', Date.now() - 100_000],
    ['chan-new', Date.now()]
  ]);
  const auxLocks = new Map([
    ['chan-old', Promise.resolve()],
    ['chan-new', Promise.resolve()]
  ]);
  const auxQueue = new Map([
    ['chan-old', 0],
    ['chan-new', 1]
  ]);
  aiUtils.pruneConversationHistories(auxHistory, auxActivity, 0, 60_000, auxLocks, auxQueue);
  expect(auxHistory.has('chan-old')).toBe(false);
  expect(auxLocks.has('chan-old')).toBe(false);
  expect(auxQueue.has('chan-old')).toBe(false);
  expect(auxLocks.has('chan-new')).toBe(true);
  expect(auxQueue.has('chan-new')).toBe(true);
});

test('should splitMessage skips whitespace-only chunks', () => {
  const text = `${'   '.repeat(400)}${'a'.repeat(500)}`;
  const chunks = aiUtils.splitMessage(text, 300);
  expect(chunks.every(chunk => chunk.length > 0)).toBe(true);
  expect(chunks.join('').replace(/\s/g, '')).toBe('a'.repeat(500));
});

test('should pruneStaleMapEntries removes expired timestamps and ignores invalid input', () => {
  const map = new Map([
    ['old', Date.now() - 10_000],
    ['fresh', Date.now()]
  ]);
  aiUtils.pruneStaleMapEntries(map, 5000);
  expect(map.has('old')).toBe(false);
  expect(map.has('fresh')).toBe(true);

  aiUtils.pruneStaleMapEntries(null, 5000);
  aiUtils.pruneStaleMapEntries(map, 0);
});

test('should stripImagesFromHistory replaces prior image parts', () => {
  const history = [
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,OLD' }]
    },
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,NEW' }] },
    { role: 'assistant', content: 'done' }
  ];
  aiUtils.stripImagesFromHistory(history);
  expect(history[1].content[0]).toEqual({ type: 'input_text', text: '[Previous Image Processed]' });
  expect(history[2].content[0]).toEqual({ type: 'input_text', text: '[Previous Image Processed]' });
  aiUtils.stripImagesFromHistory(null);
});

test('should mergeMessageContent appends text to existing input_text parts', () => {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { role: 'user', content: 'world' }
  ];
  aiUtils.normalizeConversationRoles(history);
  expect(history[1].content).toEqual([{ type: 'input_text', text: 'hello\n\nworld' }]);
});

test('should mergeMessageContent ignores non-text incoming content shapes', () => {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { role: 'user', content: 42 }
  ];
  aiUtils.normalizeConversationRoles(history);
  expect(history[1].content).toEqual([{ type: 'input_text', text: 'hello' }]);
});

test('should mergeMessageContent treats falsy numeric existing content as empty text', () => {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 0 },
    { role: 'user', content: 'more' }
  ];
  aiUtils.normalizeConversationRoles(history);
  expect(history[1].content).toEqual([{ type: 'input_text', text: 'more' }]);
});

test('should normalizeConversationRoles skips invalid history entries', () => {
  const history = [
    { role: 'system', content: 'sys' },
    null,
    { role: 'user', content: [{ type: 'input_text', text: 'a' }, null] },
    { role: 'user', content: 'b' }
  ];
  aiUtils.normalizeConversationRoles(history);
  expect(history.length).toBe(2);
  expect(history[1].content).toEqual([{ type: 'input_text', text: 'a\n\nb' }, null]);
});

test('should mergeMessageContent skips non-text array parts when joining content', () => {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'x' }, null, { type: 'input_text', text: 'a' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'tail' }] }
  ];
  aiUtils.normalizeConversationRoles(history);
  expect(history[1].content).toEqual([
    { type: 'input_image', image_url: 'x' },
    null,
    { type: 'input_text', text: 'a\n\ntail' }
  ]);
});

test('should isSupportedVisionImageType rejects SVG content types', () => {
  expect(aiUtils.isSupportedVisionImageType('image/png')).toBe(true);
  expect(aiUtils.isSupportedVisionImageType('image/svg+xml')).toBe(false);
  expect(aiUtils.isSupportedVisionImageType('text/plain')).toBe(false);
  expect(aiUtils.isSupportedVisionImageType(null)).toBe(false);
});

test('should isBusyAIErrorReason identifies retryable provider states', () => {
  expect(aiUtils.isBusyAIErrorReason('overloaded')).toBe(true);
  expect(aiUtils.isBusyAIErrorReason('rate_limit')).toBe(true);
  expect(aiUtils.isBusyAIErrorReason('timeout')).toBe(false);
});

test('should collectReplyChainMedia skips SVG attachments', () => {
  const chain = [{
    author: { id: 'user-1' },
    attachments: {
      size: 1,
      values: () => [{ url: 'https://cdn.discordapp.com/x.svg', contentType: 'image/svg+xml' }]
    },
    embeds: []
  }];
  const result = aiUtils.collectReplyChainMedia(chain, 'bot-123');
  expect(result.attachments.length).toBe(0);
});

test('should collectReplyChainMedia gathers chain attachments in order and skips bot messages', () => {
  const chain = [
    {
      author: { id: 'user-1' },
      attachments: {
        size: 1,
        values: () => [{ url: 'https://cdn.discordapp.com/one.png', contentType: 'image/png' }]
      },
      embeds: []
    },
    {
      author: { id: 'bot-123' },
      attachments: {
        size: 1,
        values: () => [{ url: 'https://cdn.discordapp.com/bot.png', contentType: 'image/png' }]
      },
      embeds: []
    },
    {
      author: { id: 'user-2' },
      attachments: {
        size: 1,
        values: () => [{ url: 'https://cdn.discordapp.com/two.png', contentType: 'image/png' }]
      },
      embeds: []
    }
  ];

  const { attachments, truncated, attachmentSources, embedSources } = aiUtils.collectReplyChainMedia(
    chain,
    'bot-123',
    { maxImages: 10 }
  );
  expect(attachments.map(a => a.url)).toEqual([
    'https://cdn.discordapp.com/one.png',
    'https://cdn.discordapp.com/two.png'
  ]);
  expect(truncated).toBe(false);
  expect(attachmentSources).toBe(2);
  expect(embedSources).toBe(0);
});

test('should collectReplyChainMedia dedupes URLs and respects maxImages cap', () => {
  const shared = { url: 'https://cdn.discordapp.com/same.png', contentType: 'image/png' };
  const chain = [
    {
      author: { id: 'user-1' },
      attachments: { size: 1, values: () => [shared] },
      embeds: [{ image: { url: 'https://cdn.discordapp.com/same.png' } }]
    },
    {
      author: { id: 'user-2' },
      attachments: { size: 1, values: () => [{ url: 'https://cdn.discordapp.com/other.png', contentType: 'image/png' }] },
      embeds: []
    }
  ];

  const capped = aiUtils.collectReplyChainMedia(chain, 'bot-123', { maxImages: 1 });
  expect(capped.attachments).toHaveLength(1);
  expect(capped.truncated).toBe(true);

  const empty = aiUtils.collectReplyChainMedia(null, 'bot-123');
  expect(empty.attachments).toEqual([]);
});

test('should collectReplyChainMedia extracts embed image previews', () => {
  const chain = [
    {
      author: { id: 'user-1' },
      attachments: { size: 0, values: () => [] },
      embeds: [{ image: { url: 'https://cdn.discordapp.com/attachments/a/b/preview.gif' } }]
    }
  ];

  const { attachments, embedSources } = aiUtils.collectReplyChainMedia(chain, 'bot-123');
  expect(attachments).toHaveLength(1);
  expect(attachments[0].contentType).toBe('image/gif');
  expect(embedSources).toBe(1);
});

test('should collectReplyChainMedia skips non-Discord and non-image attachments', () => {
  const chain = [
    {
      author: { id: 'user-1' },
      attachments: {
        size: 2,
        values: () => [
          { url: 'https://evil.example/x.png', contentType: 'image/png' },
          { url: 'https://cdn.discordapp.com/doc.pdf', contentType: 'application/pdf' }
        ]
      },
      embeds: [{ image: { url: 'https://tenor.com/view.gif' } }]
    }
  ];

  const { attachments } = aiUtils.collectReplyChainMedia(chain, 'bot-123');
  expect(attachments).toEqual([]);
});

test('should normalizeMediaUrl and inferImageContentTypeFromUrl handle edge cases', () => {
  expect(aiUtils.normalizeMediaUrl(null)).toBeUndefined();
  expect(aiUtils.normalizeMediaUrl({ proxyURL: 'https://cdn.discordapp.com/p.png' })).toBe(
    'https://cdn.discordapp.com/p.png'
  );
  expect(aiUtils.normalizeMediaUrl({ proxyUrl: 'https://cdn.discordapp.com/q.png' })).toBe(
    'https://cdn.discordapp.com/q.png'
  );

  expect(aiUtils.inferImageContentTypeFromUrl('https://cdn.discordapp.com/a.webp')).toBe('image/webp');
  expect(aiUtils.inferImageContentTypeFromUrl('https://cdn.discordapp.com/a.png')).toBe('image/png');
  expect(aiUtils.inferImageContentTypeFromUrl('https://cdn.discordapp.com/a.jpg')).toBe('image/jpeg');
  expect(aiUtils.inferImageContentTypeFromUrl('https://cdn.discordapp.com/a.jpeg')).toBe('image/jpeg');
  expect(aiUtils.inferImageContentTypeFromUrl('https://cdn.discordapp.com/noext')).toBe('image/png');
});

test('should collectReplyChainMedia handles thumbnail embeds and attachment map without values()', () => {
  const thumbOnly = aiUtils.collectReplyChainMedia(
    [{
      author: { id: 'user-1' },
      attachments: { size: 0, values: () => [] },
      embeds: [{ thumbnail: { url: 'https://cdn.discordapp.com/thumb.webp' } }]
    }],
    'bot-123'
  );
  expect(thumbOnly.attachments).toHaveLength(1);
  expect(thumbOnly.attachments[0].contentType).toBe('image/webp');
  expect(thumbOnly.embedSources).toBe(1);

  const noValuesFn = aiUtils.collectReplyChainMedia(
    [{
      author: { id: 'user-1' },
      attachments: { size: 1 },
      embeds: []
    }],
    'bot-123'
  );
  expect(noValuesFn.attachments).toEqual([]);
});

test('should collectReplyChainMedia truncates across embed urls and chain messages', () => {
  const embedCap = aiUtils.collectReplyChainMedia(
    [{
      author: { id: 'user-1' },
      attachments: { size: 0, values: () => [] },
      embeds: [{
        image: { url: 'https://cdn.discordapp.com/first.png' },
        thumbnail: { url: 'https://cdn.discordapp.com/second.jpg' }
      }]
    }],
    'bot-123',
    { maxImages: 1 }
  );
  expect(embedCap.attachments).toHaveLength(1);
  expect(embedCap.truncated).toBe(true);

  const chainCap = aiUtils.collectReplyChainMedia(
    [
      {
        author: { id: 'user-1' },
        attachments: {
          size: 1,
          values: () => [{ url: 'https://cdn.discordapp.com/m1.png', contentType: 'image/png' }]
        },
        embeds: []
      },
      {
        author: { id: 'user-2' },
        attachments: {
          size: 1,
          values: () => [{ url: 'https://cdn.discordapp.com/m2.png', contentType: 'image/png' }]
        },
        embeds: []
      }
    ],
    'bot-123',
    { maxImages: 1 }
  );
  expect(chainCap.attachments).toHaveLength(1);
  expect(chainCap.truncated).toBe(true);
});
