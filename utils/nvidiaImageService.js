const path = require('path');
const {
  nvidiaApiKey,
  nvidiaImageTimeoutMs,
  NVIDIA_IMAGE_MODELS,
  NVIDIA_ASPECT_RATIOS,
  DEFAULT_NVIDIA_IMAGE_MODEL
} = require('../config');
const { captureError, recordCount, recordDistribution, startSpan } = require('../instrument');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('./logSanitize');

const NVIDIA_GENAI_BASE = 'https://ai.api.nvidia.com/v1/genai';

class NvidiaImageError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, userMessage?: string, status?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'NvidiaImageError';
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.status = options.status;
  }
}

class ContentFilteredError extends NvidiaImageError {
  constructor() {
    super('Image generation blocked by content filter.', {
      code: 'content_filtered',
      userMessage: '⚠️ That prompt was blocked by the content filter. Try rephrasing it.'
    });
    this.name = 'ContentFilteredError';
  }
}

/**
 * @param {string} modelId
 * @returns {typeof NVIDIA_IMAGE_MODELS[string]}
 */
function resolveModelEntry(modelId) {
  const id = (modelId || DEFAULT_NVIDIA_IMAGE_MODEL).trim();
  const entry = NVIDIA_IMAGE_MODELS[id];
  if (!entry) {
    throw new NvidiaImageError(`Unsupported NVIDIA image model "${id}".`, {
      code: 'unsupported_model',
      userMessage: '⚠️ That image model is not supported.'
    });
  }
  return { id, ...entry };
}

/**
 * @param {string} aspectRatio
 * @returns {{ width: number, height: number, aspectRatio: string }}
 */
function resolveAspectRatio(aspectRatio) {
  const ratio = aspectRatio && NVIDIA_ASPECT_RATIOS[aspectRatio]
    ? aspectRatio
    : '1:1';
  return { ...NVIDIA_ASPECT_RATIOS[ratio], aspectRatio: ratio };
}

/**
 * @param {typeof NVIDIA_IMAGE_MODELS[string] & { id: string }} model
 * @param {{ prompt: string, width: number, height: number, seed: number }} params
 * @returns {Record<string, unknown>}
 */
function buildPayload(model, params) {
  const full = {
    prompt: params.prompt,
    width: params.width,
    height: params.height,
    seed: params.seed,
    steps: model.defaultSteps ?? 4
  };

  const payload = {};
  for (const field of model.payloadFields) {
    if (full[field] !== undefined) {
      payload[field] = full[field];
    }
  }
  return payload;
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readErrorBody(response) {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      const json = JSON.parse(text);
      if (typeof json.detail === 'string') return json.detail;
      if (Array.isArray(json.detail)) {
        return json.detail.map(item => item.msg || JSON.stringify(item)).join('; ');
      }
      return JSON.stringify(json);
    } catch (_) {
      return text.slice(0, 500);
    }
  } catch (_) {
    return '';
  }
}

/**
 * Maps HTTP status codes to user-facing messages.
 * @param {number} status
 * @param {string} detail
 */
function mapHttpError(status, detail) {
  if (status === 401 || status === 403) {
    return new NvidiaImageError('NVIDIA API authentication failed.', {
      code: 'auth_error',
      status,
      userMessage: '⚠️ Image generation is not configured correctly (invalid NVIDIA API key).'
    });
  }
  if (status === 429) {
    return new NvidiaImageError('NVIDIA API rate limit exceeded.', {
      code: 'rate_limit',
      status,
      userMessage: '⚠️ Image generation is rate-limited right now. Please try again in a moment.'
    });
  }
  if (status === 422) {
    return new NvidiaImageError(`NVIDIA API validation error: ${detail}`, {
      code: 'validation_error',
      status,
      userMessage: '⚠️ That request could not be processed. Try a different prompt or model.'
    });
  }
  if (status >= 500) {
    return new NvidiaImageError(`NVIDIA API server error (${status}).`, {
      code: 'server_error',
      status,
      userMessage: '⚠️ The image service is temporarily unavailable. Please try again later.'
    });
  }
  if (status === 404) {
    return new NvidiaImageError(`NVIDIA API endpoint not found (${status}): ${detail}`, {
      code: 'not_found',
      status,
      userMessage: '⚠️ That image model is not available on NVIDIA\'s hosted API. Try a different model.'
    });
  }
  return new NvidiaImageError(`NVIDIA API error (${status}): ${detail}`, {
    code: 'api_error',
    status,
    userMessage: '⚠️ Image generation failed. Please try again.'
  });
}

/**
 * Generates an image via NVIDIA NIM cloud GenAI API.
 * @param {{ prompt: string, modelId?: string, aspectRatio?: string, seed?: number }} options
 * @returns {Promise<{ buffer: Buffer, contentType: string, seed: number, modelId: string, finishReason: string, aspectRatio: string }>}
 */
async function generateImage({ prompt, modelId, aspectRatio, seed }) {
  if (!nvidiaApiKey) {
    throw new NvidiaImageError('NVIDIA_API_KEY is not configured.', {
      code: 'missing_api_key',
      userMessage: '⚠️ Image generation is not configured (missing NVIDIA API key).'
    });
  }

  const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  if (!trimmedPrompt) {
    throw new NvidiaImageError('Prompt is required.', {
      code: 'missing_prompt',
      userMessage: '⚠️ Please provide a prompt.'
    });
  }

  const model = resolveModelEntry(modelId);
  const dimensions = resolveAspectRatio(aspectRatio);
  const resolvedSeed = typeof seed === 'number' && seed >= 0 ? seed : 0;
  const url = `${NVIDIA_GENAI_BASE}/${model.apiPath}`;
  const payload = buildPayload(model, {
    prompt: trimmedPrompt,
    width: dimensions.width,
    height: dimensions.height,
    seed: resolvedSeed
  });

  const startedAt = Date.now();

  return startSpan({ op: 'nvidia.image', name: model.id }, async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), nvidiaImageTimeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nvidiaApiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new NvidiaImageError('NVIDIA image request timed out.', {
          code: 'timeout',
          userMessage: '⚠️ Image generation timed out. Try again with a simpler prompt.'
        });
      }
      captureError(error, { source: 'nvidiaImageService', modelId: model.id });
      throw new NvidiaImageError(error.message || 'Network error.', {
        code: 'network_error',
        userMessage: '⚠️ Could not reach the image service. Please try again.'
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      const mapped = mapHttpError(response.status, detail);
      captureError(mapped, {
        source: 'nvidiaImageService',
        modelId: model.id,
        status: response.status
      });
      recordCount('nvidia.image.error', 1, { model: model.id, status: String(response.status) });
      throw mapped;
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      captureError(error, { source: 'nvidiaImageService', modelId: model.id });
      throw new NvidiaImageError('Invalid JSON response from NVIDIA API.', {
        code: 'invalid_response',
        userMessage: '⚠️ Image generation returned an unexpected response.'
      });
    }

    const artifact = body?.artifacts?.[0];
    if (!artifact?.base64) {
      throw new NvidiaImageError('Missing image artifact in NVIDIA response.', {
        code: 'missing_artifact',
        userMessage: '⚠️ Image generation did not return an image.'
      });
    }

    const finishReason = artifact.finishReason || 'UNKNOWN';
    if (finishReason === 'CONTENT_FILTERED') {
      recordCount('nvidia.image.filtered', 1, { model: model.id });
      throw new ContentFilteredError();
    }
    if (finishReason !== 'SUCCESS') {
      throw new NvidiaImageError(`Image generation failed: ${finishReason}.`, {
        code: 'generation_failed',
        userMessage: '⚠️ Image generation failed. Please try a different prompt.'
      });
    }

    const buffer = Buffer.from(artifact.base64, 'base64');
    const elapsedMs = Date.now() - startedAt;

    recordCount('nvidia.image.success', 1, { model: model.id });
    recordDistribution('nvidia.image.duration_ms', elapsedMs, { model: model.id });

    logger.info('NVIDIA image generated.', {
      modelId: model.id,
      aspectRatio: dimensions.aspectRatio,
      seed: artifact.seed ?? resolvedSeed,
      finishReason,
      bytes: buffer.length,
      elapsedMs
    });

    return {
      buffer,
      contentType: 'image/jpeg',
      seed: artifact.seed ?? resolvedSeed,
      modelId: model.id,
      finishReason,
      aspectRatio: dimensions.aspectRatio
    };
  });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatImageUserMessage(error) {
  if (error instanceof NvidiaImageError && error.userMessage) {
    return error.userMessage;
  }
  return '⚠️ Image generation failed. Please try again.';
}

module.exports = {
  generateImage,
  resolveModelEntry,
  resolveAspectRatio,
  buildPayload,
  formatImageUserMessage,
  NvidiaImageError,
  ContentFilteredError,
  NVIDIA_GENAI_BASE
};
