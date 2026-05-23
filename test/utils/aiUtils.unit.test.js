const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const aiUtils = require(path.resolve(__dirname, '..', '..', 'utils', 'aiUtils.js'));

test('splitMessage returns empty array for empty input', () => {
  const parts = aiUtils.splitMessage('', 2000);
  assert.deepEqual(parts, []);
});

test('splitMessage does not split short text', () => {
  const text = 'hello world';
  const parts = aiUtils.splitMessage(text, 2000);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], text);
});

test('createMessageContent includes text and images', () => {
  const imgs = [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }];
  const res = aiUtils.createMessageContent(' hi ', imgs);
  assert.equal(res.length, 2);
  assert.equal(res[0].type, 'input_text');
  assert.equal(res[0].text, 'hi');
  assert.equal(res[1].type, 'input_image');
});

test('hasImages detects images in conversation', () => {
  const conv = [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:' }] }];
  assert.equal(aiUtils.hasImages(conv), true);
});

test('estimateTokensFromText basic heuristic', () => {
  assert.equal(aiUtils.estimateTokensFromText('abcd'), 1);
  assert.equal(aiUtils.estimateTokensFromText('abcdefgh'), 2);
});

// estimateMessageTokens is internal and not exported; validate estimateTokensFromText instead

test('estimateTokensFromText behaves reasonably', () => {
  assert.equal(aiUtils.estimateTokensFromText('a'.repeat(4)), 1);
  assert.equal(aiUtils.estimateTokensFromText('a'.repeat(8)), 2);
});

test('trimConversationHistory preserves system message and trims by length', () => {
  const history = [ { role: 'system', content: 'sys' } ];
  for (let i = 0; i < 10; i++) history.push({ role: 'user', content: `m${i}` });
  aiUtils.trimConversationHistory(history, 3, 0);
  assert.equal(history[0].role, 'system');
  assert(history.length <= 4);
});

test('createSystemMessage respects includeModelInPrompt flag', () => {
  const sys = aiUtils.createSystemMessage('model-x', true);
  assert(sys.role === 'system');
  assert(typeof sys.content === 'string');
  const sys2 = aiUtils.createSystemMessage('model-x', false);
  assert(sys2.role === 'system');
});

test('assertDiscordImageDownloadUrl rejects non-https and invalid hosts', () => {
  assert.throws(() => aiUtils.assertDiscordImageDownloadUrl('http://example.com/img.png'));
  assert.throws(() => aiUtils.assertDiscordImageDownloadUrl('https://evil.com/img.png'));
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

test('downloadImageAsBase64 downloads a Discord CDN image (coverage merged)', async () => {
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
    assert.match(result, /^data:image\/png;base64,/);
  });
});

test('downloadImageAsBase64 follows a redirect and rejects unsupported content types (coverage merged)', async () => {
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
    await assert.rejects(
      async () => aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png'),
      /Unsupported content-type/
    );
    assert.equal(calls.length, 2);
  });
});

test('processImageAttachments keeps image order and skips non-image attachments (coverage merged)', async () => {
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
    assert.equal(processed.length, 2);
    assert.equal(processed[0].type, 'input_image');
    assert.equal(processed[1].type, 'input_image');
    assert.notEqual(processed[0].image_url, processed[1].image_url);
  });
});

test('trimConversationHistory applies the token cap (coverage merged)', () => {
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
  assert.equal(trimmed[0].role, 'system');
  assert.equal(trimmed.length < originalLength, true);
});

test('splitMessage splits on paragraph boundaries and handles failures (coverage merged)', () => {
  const paragraphText = `${'a'.repeat(850)}\n\n${'b'.repeat(500)}`;
  const chunks = aiUtils.splitMessage(paragraphText, 800);
  assert.equal(chunks.length >= 2, true);

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
  assert.deepEqual(fallback, ['Error splitting message']);
});

test('downloadImageAsBase64 rejects invalid URLs, redirects, and oversized images (coverage merged)', async () => {
  await assert.rejects(
    async () => aiUtils.downloadImageAsBase64('not-a-url'),
    /Invalid image URL/
  );

  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => callback(createResponse(404, { 'content-type': 'image/png' }, [])));
    return request;
  }, async () => {
    await assert.rejects(
      async () => aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png'),
      /HTTP 404/
    );
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
    await assert.rejects(
      async () => aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png'),
      /Too many redirects/
    );
    assert.equal(redirectCount >= 4, true);
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
    await assert.rejects(
      async () => aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png'),
      /exceeds max size/
    );
  });
});

test('splitMessage splits on sentence and word boundaries', () => {
  const sentenceText = `${'a'.repeat(550)}. ${'b'.repeat(300)}`;
  const sentenceChunks = aiUtils.splitMessage(sentenceText, 800);
  assert.equal(sentenceChunks.length >= 2, true);

  const wordText = `${'a'.repeat(500)} ${'b'.repeat(300)}`;
  const wordChunks = aiUtils.splitMessage(wordText, 800);
  assert.equal(wordChunks.length >= 2, true);

  const newlineText = `${'a'.repeat(700)}\n${'b'.repeat(200)}`;
  const newlineChunks = aiUtils.splitMessage(newlineText, 800);
  assert.equal(newlineChunks.length >= 2, true);

  const paragraphText = `${'a'.repeat(650)}\n\n${'b'.repeat(200)}`;
  const paragraphChunks = aiUtils.splitMessage(paragraphText, 800);
  assert.equal(paragraphChunks.length >= 2, true);
});

test('downloadImageAsBase64 handles request timeout and network errors', async () => {
  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = (_ms, handler) => queueMicrotask(() => handler());
    request.destroy = error => request.emit('error', error);
    return request;
  }, async () => {
    await assert.rejects(
      async () => aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png'),
      /timed out/
    );
  });

  await withHttpsStub(() => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => request.emit('error', new Error('network down')));
    return request;
  }, async () => {
    await assert.rejects(
      async () => aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png'),
      /network down/
    );
  });
});

test('downloadImageAsBase64 rejects oversized streamed payloads', async () => {
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
      await assert.rejects(
        async () => smallLimitUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png'),
        /exceeds max size/
      );
    });
  } finally {
    if (savedMax === undefined) delete process.env.MAX_IMAGE_BYTES;
    else process.env.MAX_IMAGE_BYTES = savedMax;
    delete require.cache[aiUtilsPath];
    delete require.cache[configPath];
  }
});

test('processImageAttachments handles non-array input and attachment label fallbacks', async () => {
  assert.deepEqual(await aiUtils.processImageAttachments(null), []);
  assert.deepEqual(await aiUtils.processImageAttachments('not-an-array'), []);

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
    assert.equal(urlOnly.length, 1);

    const nameOnly = await aiUtils.processImageAttachments([
      { contentType: 'image/png', name: 'named.png', url: 'https://cdn.discordapp.com/by-name.png' }
    ]);
    assert.equal(nameOnly.length, 1);

    const filenameOnly = await aiUtils.processImageAttachments([
      { contentType: 'image/png', filename: 'file.png', url: 'https://cdn.discordapp.com/by-filename.png' }
    ]);
    assert.equal(filenameOnly.length, 1);

    const emptyNameUsesFilename = await aiUtils.processImageAttachments([
      { contentType: 'image/png', name: '', filename: 'fallback.png', url: 'https://cdn.discordapp.com/fallback.png' }
    ]);
    assert.equal(emptyNameUsesFilename.length, 1);

    const unknownLabel = await aiUtils.processImageAttachments([
      { contentType: 'image/png' }
    ]);
    assert.equal(unknownLabel.length, 0);
  });
});

test('downloadImageAsBase64 treats missing statusCode as zero', async () => {
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
    await assert.rejects(
      async () => aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png'),
      /HTTP 0/
    );
  });
});

test('trimConversationHistory token trimming handles null messages and non-array content', () => {
  const history = [
    { role: 'system', content: 'sys' },
    null,
    { role: 'user', content: null },
    { role: 'user', content: { not: 'array' } },
    { role: 'user', content: 'a'.repeat(400) }
  ];
  aiUtils.trimConversationHistory(history, 10, 1);
  assert.equal(history[0].role, 'system');
});

test('downloadImageAsBase64 rejects redirect targets with invalid hosts', async () => {
  await withHttpsStub((url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => callback(createResponse(302, { location: 'https://evil.example/redirect.png' })));
    return request;
  }, async () => {
    await assert.rejects(
      async () => aiUtils.downloadImageAsBase64('https://cdn.discordapp.com/image.png'),
      /Discord CDN/
    );
  });
});
