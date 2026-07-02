const path = require('path');
const { stubModule, reloadModule, defaultInstrumentStub } = require('./testUtils.cjs');

const servicePath = path.resolve(__dirname, '..', 'utils', 'nvidiaImageService.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');

const SAMPLE_JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA//2Q==';

function loadService({ configOverrides = {}, fetchImpl } = {}) {
  if (fetchImpl) {
    global.fetch = fetchImpl;
  }

  return reloadModule(servicePath, () => {
    stubModule(instrumentPath, defaultInstrumentStub());
    stubModule(configPath, {
      nvidiaApiKey: 'nvapi-test-key',
      nvidiaImageTimeoutMs: 5000,
      NVIDIA_IMAGE_MODELS: {
        'flux.1-schnell': {
          apiPath: 'black-forest-labs/flux.1-schnell',
          label: 'FLUX.1 Schnell',
          payloadFields: ['prompt', 'width', 'height', 'seed']
        },
        'flux.1-dev': {
          apiPath: 'black-forest-labs/flux.1-dev',
          label: 'FLUX.1 Dev',
          payloadFields: ['prompt', 'width', 'height', 'seed', 'steps'],
          defaultSteps: 28
        }
      },
      NVIDIA_ASPECT_RATIOS: {
        '1:1': { width: 1024, height: 1024 },
        '16:9': { width: 1344, height: 768 }
      },
      DEFAULT_NVIDIA_IMAGE_MODEL: 'flux.1-schnell',
      ...configOverrides
    });
  });
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test('should resolve model entry and aspect ratio', () => {
  const svc = loadService();
  expect(svc.resolveModelEntry('flux.1-schnell').apiPath).toBe('black-forest-labs/flux.1-schnell');
  expect(svc.resolveAspectRatio('16:9')).toMatchObject({ width: 1344, height: 768, aspectRatio: '16:9' });
  expect(svc.resolveAspectRatio('unknown')).toMatchObject({ width: 1024, height: 1024, aspectRatio: '1:1' });
});

test('should build payload with only allowed fields per model', () => {
  const svc = loadService();
  const schnell = svc.resolveModelEntry('flux.1-schnell');
  expect(svc.buildPayload(schnell, { prompt: 'cat', width: 1024, height: 1024, seed: 0 })).toEqual({
    prompt: 'cat',
    width: 1024,
    height: 1024,
    seed: 0
  });

  const dev = svc.resolveModelEntry('flux.1-dev');
  expect(svc.buildPayload(dev, { prompt: 'cat', width: 1024, height: 1024, seed: 0 })).toEqual({
    prompt: 'cat',
    width: 1024,
    height: 1024,
    seed: 0,
    steps: 28
  });
});

test('should generate image from successful API response', async () => {
  let capturedUrl;
  let capturedBody;
  const svc = loadService({
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          artifacts: [{ base64: SAMPLE_JPEG_B64, finishReason: 'SUCCESS', seed: 42 }]
        })
      };
    }
  });

  const result = await svc.generateImage({ prompt: 'a red apple', aspectRatio: '1:1' });

  expect(capturedUrl).toBe('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell');
  expect(capturedBody).toEqual({ prompt: 'a red apple', width: 1024, height: 1024, seed: 0 });
  expect(result.buffer).toBeInstanceOf(Buffer);
  expect(result.seed).toBe(42);
  expect(result.modelId).toBe('flux.1-schnell');
  expect(result.contentType).toBe('image/jpeg');
});

test('should reject missing API key', async () => {
  const svc = loadService({ configOverrides: { nvidiaApiKey: undefined } });
  await expect(svc.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/not configured/)
  });
});

test('should reject empty prompt', async () => {
  const svc = loadService();
  await expect(svc.generateImage({ prompt: '   ' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/provide a prompt/)
  });
});

test('should handle content filtered responses', async () => {
  const svc = loadService({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        artifacts: [{ base64: SAMPLE_JPEG_B64, finishReason: 'CONTENT_FILTERED', seed: 1 }]
      })
    })
  });

  await expect(svc.generateImage({ prompt: 'blocked' })).rejects.toMatchObject({
    name: 'ContentFilteredError',
    userMessage: expect.stringMatching(/content filter/)
  });
});

test('should map HTTP 401 and 429 errors', async () => {
  const svc401 = loadService({
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
  });
  await expect(svc401.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/API key/)
  });

  const svc429 = loadService({
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limit' })
  });
  await expect(svc429.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/rate-limited/)
  });
});

test('should handle timeout abort', async () => {
  const svc = loadService({
    configOverrides: { nvidiaImageTimeoutMs: 10 },
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })
  });

  await expect(svc.generateImage({ prompt: 'slow' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/timed out/)
  });
}, 15_000);

test('should handle malformed response without artifact', async () => {
  const svc = loadService({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ artifacts: [] })
    })
  });

  await expect(svc.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/did not return an image/)
  });
});

test('should format user-facing error messages', () => {
  const svc = loadService();
  expect(svc.formatImageUserMessage(new svc.NvidiaImageError('x', { userMessage: '⚠️ Custom' }))).toBe('⚠️ Custom');
  expect(svc.formatImageUserMessage(new Error('boom'))).toMatch(/failed/);
});

test('should reject unsupported model id', () => {
  const svc = loadService();
  try {
    svc.resolveModelEntry('not-a-model');
    throw new Error('expected throw');
  } catch (error) {
    expect(error).toBeInstanceOf(svc.NvidiaImageError);
    expect(error.userMessage).toMatch(/not supported/);
  }
});

test('should map HTTP 403, 422, 500, and generic API errors', async () => {
  const cases = [
    { status: 403, match: /API key/ },
    { status: 422, body: JSON.stringify({ detail: [{ msg: 'bad field' }] }), match: /could not be processed/ },
    { status: 500, body: 'server down', match: /temporarily unavailable/ },
    { status: 418, body: 'teapot', match: /failed/ }
  ];

  for (const { status, body = '', match } of cases) {
    const svc = loadService({
      fetchImpl: async () => ({
        ok: false,
        status,
        text: async () => body
      })
    });
    await expect(svc.generateImage({ prompt: 'test' })).rejects.toMatchObject({
      userMessage: expect.stringMatching(match)
    });
  }
});

test('should handle readErrorBody edge cases', async () => {
  const svc = loadService({
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => '{not-json'
    })
  });
  await expect(svc.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/failed/)
  });

  const emptyBody = loadService({
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => ''
    })
  });
  await expect(emptyBody.generateImage({ prompt: 'test' })).rejects.toBeTruthy();

  const stringDetail = loadService({
    fetchImpl: async () => ({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ detail: 'invalid prompt' })
    })
  });
  await expect(stringDetail.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/could not be processed/)
  });

  const readFail = loadService({
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => {
        throw new Error('read failed');
      }
    })
  });
  await expect(readFail.generateImage({ prompt: 'test' })).rejects.toBeTruthy();

  const jsonWithoutDetail = loadService({
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: 'bad request' })
    })
  });
  await expect(jsonWithoutDetail.generateImage({ prompt: 'test' })).rejects.toBeTruthy();
});

test('should handle network errors other than timeout', async () => {
  const svc = loadService({
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    }
  });
  await expect(svc.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/Could not reach/)
  });
});

test('should handle invalid JSON in success response', async () => {
  const svc = loadService({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        throw new Error('invalid json');
      }
    })
  });
  await expect(svc.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/unexpected response/)
  });
});

test('should handle non-success finish reasons', async () => {
  const svc = loadService({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        artifacts: [{ base64: SAMPLE_JPEG_B64, finishReason: 'ERROR', seed: 1 }]
      })
    })
  });
  await expect(svc.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/failed/)
  });
});

test('should honor explicit seed in request payload', async () => {
  let capturedBody;
  const svc = loadService({
    fetchImpl: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          artifacts: [{ base64: SAMPLE_JPEG_B64, finishReason: 'SUCCESS', seed: 777 }]
        })
      };
    }
  });

  await svc.generateImage({ prompt: 'seeded', seed: 12345 });
  expect(capturedBody.seed).toBe(12345);
});

test('should default model when modelId omitted', async () => {
  let capturedUrl;
  const svc = loadService({
    fetchImpl: async url => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          artifacts: [{ base64: SAMPLE_JPEG_B64, finishReason: 'SUCCESS', seed: 1 }]
        })
      };
    }
  });

  await svc.generateImage({ prompt: 'default model' });
  expect(capturedUrl).toContain('flux.1-schnell');
});

test('should handle readErrorBody detail items without msg', async () => {
  const svc = loadService({
    fetchImpl: async () => ({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ detail: [{ code: 'bad' }] })
    })
  });
  await expect(svc.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/could not be processed/)
  });
});

test('should reject non-string prompts and network errors without messages', async () => {
  const svc = loadService();
  await expect(svc.generateImage({ prompt: null })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/provide a prompt/)
  });

  const networkSvc = loadService({
    fetchImpl: async () => {
      throw {};
    }
  });
  await expect(networkSvc.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/Could not reach/)
  });
});

test('should handle missing finish reason and fallback seed values', async () => {
  const svc = loadService({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        artifacts: [{ base64: SAMPLE_JPEG_B64, finishReason: 'SUCCESS' }]
      })
    })
  });
  const result = await svc.generateImage({ prompt: 'seed fallback', seed: 999 });
  expect(result.seed).toBe(999);

  const failSvc = loadService({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        artifacts: [{ base64: SAMPLE_JPEG_B64, finishReason: 'BOOM', seed: 1 }]
      })
    })
  });
  await expect(failSvc.generateImage({ prompt: 'fail reason' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/failed/)
  });

  const unknownSvc = loadService({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        artifacts: [{ base64: SAMPLE_JPEG_B64, seed: 1 }]
      })
    })
  });
  await expect(unknownSvc.generateImage({ prompt: 'unknown finish' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/failed/)
  });
});
