const path = require('path');
const { stubModule, reloadModule, defaultInstrumentStub } = require('./testUtils.cjs');

const servicePath = path.resolve(__dirname, '..', 'utils', 'geminiImageService.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');

const SAMPLE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function loadService({ configOverrides = {}, generateContentImpl } = {}) {
  return reloadModule(servicePath, () => {
    stubModule(instrumentPath, defaultInstrumentStub());
    stubModule(configPath, {
      geminiApiKey: 'gemini-test-key',
      geminiImageModel: 'gemini-3.1-flash-image',
      imageGenerationTimeoutMs: 5000,
      IMAGE_ASPECT_RATIOS: {
        '1:1': '1:1',
        '16:9': '16:9',
        '9:16': '9:16',
        '4:3': '4:3',
        '3:4': '3:4'
      },
      DEFAULT_GEMINI_IMAGE_MODEL: 'gemini-3.1-flash-image',
      ...configOverrides
    });
    stubModule('@google/genai', {
      GoogleGenAI: class {
        constructor() {
          this.models = {
            generateContent: generateContentImpl || (async () => ({
              candidates: [{
                content: {
                  parts: [{ inlineData: { data: SAMPLE_PNG_B64, mimeType: 'image/png' } }]
                }
              }]
            }))
          };
        }
      }
    });
  });
}

test('should resolve aspect ratio with fallback to 1:1', () => {
  const svc = loadService();
  expect(svc.resolveAspectRatio('16:9')).toBe('16:9');
  expect(svc.resolveAspectRatio('unknown')).toBe('1:1');
});

test('should extract image bytes from generateContent response', () => {
  const svc = loadService();
  const extracted = svc.extractImageFromResponse({
    candidates: [{
      content: {
        parts: [{ inlineData: { data: SAMPLE_PNG_B64, mimeType: 'image/png' } }]
      }
    }]
  });
  expect(extracted.filtered).toBe(false);
  expect(extracted.data).toBe(SAMPLE_PNG_B64);
});

test('should detect prompt feedback blocks', () => {
  const svc = loadService();
  const extracted = svc.extractImageFromResponse({
    promptFeedback: { blockReason: 'SAFETY' }
  });
  expect(extracted).toEqual({ filtered: true, reason: 'SAFETY' });
});

test('should generate image from successful API response', async () => {
  let capturedParams;
  const svc = loadService({
    generateContentImpl: async params => {
      capturedParams = params;
      return {
        candidates: [{
          content: {
            parts: [{ inlineData: { data: SAMPLE_PNG_B64, mimeType: 'image/png' } }]
          }
        }]
      };
    }
  });

  const result = await svc.generateImage({ prompt: 'a red apple', aspectRatio: '16:9' });

  expect(capturedParams.model).toBe('gemini-3.1-flash-image');
  expect(capturedParams.contents).toBe('a red apple');
  expect(capturedParams.config.responseModalities).toEqual(['IMAGE']);
  expect(capturedParams.config.imageConfig.aspectRatio).toBe('16:9');
  expect(result.buffer).toBeInstanceOf(Buffer);
  expect(result.modelId).toBe('gemini-3.1-flash-image');
  expect(result.contentType).toBe('image/png');
});

test('should reject missing API key', async () => {
  const svc = loadService({ configOverrides: { geminiApiKey: undefined } });
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
    generateContentImpl: async () => ({
      promptFeedback: { blockReason: 'SAFETY' }
    })
  });

  await expect(svc.generateImage({ prompt: 'blocked' })).rejects.toMatchObject({
    name: 'ContentFilteredError',
    userMessage: expect.stringMatching(/content filter/)
  });
});

test('should handle candidate safety finish reasons', async () => {
  const svc = loadService({
    generateContentImpl: async () => ({
      candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }]
    })
  });

  await expect(svc.generateImage({ prompt: 'blocked' })).rejects.toMatchObject({
    name: 'ContentFilteredError'
  });
});

test('should map API auth and rate limit errors', async () => {
  const svc401 = loadService({
    generateContentImpl: async () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    }
  });
  await expect(svc401.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/API key/)
  });

  const svc429 = loadService({
    generateContentImpl: async () => {
      throw Object.assign(new Error('rate limit'), { status: 429 });
    }
  });
  await expect(svc429.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/rate-limited/)
  });
});

test('should handle timeout', async () => {
  const svc = loadService({
    configOverrides: { imageGenerationTimeoutMs: 10 },
    generateContentImpl: () => new Promise(() => {})
  });

  await expect(svc.generateImage({ prompt: 'slow' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/timed out/)
  });
}, 15_000);

test('should handle malformed response without image bytes', async () => {
  const svc = loadService({
    generateContentImpl: async () => ({ candidates: [{ content: { parts: [] } }] })
  });

  await expect(svc.generateImage({ prompt: 'test' })).rejects.toMatchObject({
    userMessage: expect.stringMatching(/did not return an image/)
  });
});

test('should format user-facing error messages', () => {
  const svc = loadService();
  expect(svc.formatImageUserMessage(new svc.GeminiImageError('x', { userMessage: '⚠️ Custom' }))).toBe('⚠️ Custom');
  expect(svc.formatImageUserMessage(new Error('boom'))).toMatch(/failed/);
});

test('should map HTTP 400, 404, 500, and generic API errors', async () => {
  const cases = [
    { status: 400, match: /could not be processed/ },
    { status: 404, match: /not available/ },
    { status: 500, match: /temporarily unavailable/ },
    { status: 418, match: /failed/ }
  ];

  for (const { status, match } of cases) {
    const svc = loadService({
      generateContentImpl: async () => {
        throw Object.assign(new Error('api error'), { status });
      }
    });
    await expect(svc.generateImage({ prompt: 'test' })).rejects.toMatchObject({
      userMessage: expect.stringMatching(match)
    });
  }
});
