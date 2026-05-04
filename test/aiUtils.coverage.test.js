const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('node:events');

const https = require('https');
const aiUtils = require(path.resolve(__dirname, '..', 'utils', 'aiUtils.js'));

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

test('downloadImageAsBase64 downloads a Discord CDN image', async () => {
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

test('downloadImageAsBase64 follows a redirect and rejects unsupported content types', async () => {
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

test('processImageAttachments keeps image order and skips non-image attachments', async () => {
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

test('trimConversationHistory applies the token cap', () => {
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

test('splitMessage splits on paragraph boundaries and handles failures', () => {
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

test('downloadImageAsBase64 rejects invalid URLs, redirects, and oversized images', async () => {
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