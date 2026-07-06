const { GoogleGenAI } = require('@google/genai');
const path = require('path');
const {
  geminiApiKey,
  geminiImageModel,
  imageGenerationTimeoutMs,
  IMAGE_ASPECT_RATIOS,
  DEFAULT_GEMINI_IMAGE_MODEL
} = require('../config');
const { captureError, recordCount, recordDistribution, startSpan } = require('../instrument');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('./logSanitize');

/** @type {GoogleGenAI|null} */
const genAI = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

class GeminiImageError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, userMessage?: string, status?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'GeminiImageError';
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.status = options.status;
  }
}

class ContentFilteredError extends GeminiImageError {
  constructor(reason) {
    super('Image generation blocked by content filter.', {
      code: 'content_filtered',
      userMessage: '⚠️ That prompt was blocked by the content filter. Try rephrasing it.'
    });
    this.name = 'ContentFilteredError';
    this.filterReason = reason;
  }
}

/**
 * @param {string} aspectRatio
 * @returns {string}
 */
function resolveAspectRatio(aspectRatio) {
  if (aspectRatio && IMAGE_ASPECT_RATIOS[aspectRatio]) {
    return aspectRatio;
  }
  return '1:1';
}

/**
 * @param {unknown} response
 * @returns {{ filtered: true, reason: string } | { filtered: false, data: string, mimeType: string } | null}
 */
function extractImageFromResponse(response) {
  const blockReason = response?.promptFeedback?.blockReason;
  if (blockReason) {
    return { filtered: true, reason: String(blockReason) };
  }

  for (const candidate of response?.candidates ?? []) {
    const finishReason = candidate.finishReason;
    if (finishReason === 'SAFETY' || finishReason === 'IMAGE_SAFETY') {
      return { filtered: true, reason: String(finishReason) };
    }

    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.data) {
        return {
          filtered: false,
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType || 'image/png'
        };
      }
    }
  }

  return null;
}

/**
 * @param {unknown} error
 * @returns {{ status?: number, detail: string }}
 */
function parseApiError(error) {
  const status = typeof error?.status === 'number'
    ? error.status
    : typeof error?.code === 'number'
      ? error.code
      : undefined;
  const detail = typeof error?.message === 'string' ? error.message : String(error ?? 'Unknown error');
  return { status, detail };
}

/**
 * @param {number|undefined} status
 * @param {string} detail
 */
function mapApiError(status, detail) {
  if (status === 401 || status === 403) {
    return new GeminiImageError('Gemini API authentication failed.', {
      code: 'auth_error',
      status,
      userMessage: '⚠️ Image generation is not configured correctly (invalid Gemini API key).'
    });
  }
  if (status === 429) {
    return new GeminiImageError('Gemini API rate limit exceeded.', {
      code: 'rate_limit',
      status,
      userMessage: '⚠️ Image generation is rate-limited right now. Please try again in a moment.'
    });
  }
  if (status === 400 || status === 422) {
    return new GeminiImageError(`Gemini API validation error: ${detail}`, {
      code: 'validation_error',
      status,
      userMessage: '⚠️ That request could not be processed. Try a different prompt.'
    });
  }
  if (typeof status === 'number' && status >= 500) {
    return new GeminiImageError(`Gemini API server error (${status}).`, {
      code: 'server_error',
      status,
      userMessage: '⚠️ The image service is temporarily unavailable. Please try again later.'
    });
  }
  if (status === 404) {
    return new GeminiImageError(`Gemini API model not found (${status}): ${detail}`, {
      code: 'not_found',
      status,
      userMessage: '⚠️ The image model is not available. Contact the bot owner.'
    });
  }
  return new GeminiImageError(`Gemini API error${status ? ` (${status})` : ''}: ${detail}`, {
    code: 'api_error',
    status,
    userMessage: '⚠️ Image generation failed. Please try again.'
  });
}

/**
 * Rejects when a request exceeds the configured timeout.
 * @param {Promise<*>} promise
 * @param {number} timeoutMs
 */
function withRequestTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Gemini image request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    Promise.resolve(promise)
      .then(value => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Generates an image via Gemini Image (generateContent with IMAGE modality).
 * @param {{ prompt: string, aspectRatio?: string }} options
 * @returns {Promise<{ buffer: Buffer, contentType: string, modelId: string, aspectRatio: string }>}
 */
async function generateImage({ prompt, aspectRatio }) {
  if (!geminiApiKey || !genAI) {
    throw new GeminiImageError('GEMINI_API_KEY is not configured.', {
      code: 'missing_api_key',
      userMessage: '⚠️ Image generation is not configured (missing Gemini API key).'
    });
  }

  const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  if (!trimmedPrompt) {
    throw new GeminiImageError('Prompt is required.', {
      code: 'missing_prompt',
      userMessage: '⚠️ Please provide a prompt.'
    });
  }

  const modelId = geminiImageModel || DEFAULT_GEMINI_IMAGE_MODEL;
  const resolvedAspectRatio = resolveAspectRatio(aspectRatio);
  const startedAt = Date.now();

  return startSpan({ op: 'gemini.image', name: modelId }, async () => {
    try {
      const response = await withRequestTimeout(
        genAI.models.generateContent({
          model: modelId,
          contents: trimmedPrompt,
          config: {
            responseModalities: ['IMAGE'],
            imageConfig: {
              aspectRatio: resolvedAspectRatio
            }
          }
        }),
        imageGenerationTimeoutMs
      );

      const extracted = extractImageFromResponse(response);
      if (!extracted) {
        throw new GeminiImageError('Missing image in Gemini response.', {
          code: 'missing_artifact',
          userMessage: '⚠️ Image generation did not return an image.'
        });
      }
      if (extracted.filtered) {
        recordCount('gemini.image.filtered', 1, { model: modelId });
        throw new ContentFilteredError(extracted.reason);
      }

      const buffer = Buffer.from(extracted.data, 'base64');
      const elapsedMs = Date.now() - startedAt;

      recordCount('gemini.image.success', 1, { model: modelId });
      recordDistribution('gemini.image.duration_ms', elapsedMs, { model: modelId });

      logger.info('Gemini image generated.', {
        modelId,
        aspectRatio: resolvedAspectRatio,
        bytes: buffer.length,
        elapsedMs
      });

      return {
        buffer,
        contentType: extracted.mimeType,
        modelId,
        aspectRatio: resolvedAspectRatio
      };
    } catch (error) {
      if (error instanceof GeminiImageError) throw error;

      if (error?.name === 'AbortError' || /timed out/i.test(error?.message || '')) {
        throw new GeminiImageError('Gemini image request timed out.', {
          code: 'timeout',
          userMessage: '⚠️ Image generation timed out. Try again with a simpler prompt.'
        });
      }

      const { status, detail } = parseApiError(error);
      const mapped = mapApiError(status, detail);
      captureError(mapped, {
        source: 'geminiImageService',
        modelId,
        status,
        ...serializeError(error)
      });
      recordCount('gemini.image.error', 1, { model: modelId, status: String(status ?? 'unknown') });
      throw mapped;
    }
  });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatImageUserMessage(error) {
  if (error instanceof GeminiImageError && error.userMessage) {
    return error.userMessage;
  }
  return '⚠️ Image generation failed. Please try again.';
}

module.exports = {
  generateImage,
  resolveAspectRatio,
  extractImageFromResponse,
  formatImageUserMessage,
  GeminiImageError,
  ContentFilteredError
};
