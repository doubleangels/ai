const { classifyAIError, formatAIUserMessage, isAIUserErrorMessage } = require('../utils/aiUtils');

describe('classifyAIError', () => {
  test('classifies rate limit by status', () => {
    expect(classifyAIError({ status: 429, message: 'ok' })).toBe('rate_limit');
  });

  test('classifies rate limit by message', () => {
    expect(classifyAIError(new Error('Rate limit exceeded'))).toBe('rate_limit');
  });

  test('classifies timeout', () => {
    expect(classifyAIError({ status: 408 })).toBe('timeout');
    expect(classifyAIError({ code: 'ETIMEDOUT', message: 'timeout' })).toBe('timeout');
  });

  test('classifies auth and permission errors separately', () => {
    expect(classifyAIError({ status: 401 })).toBe('auth');
    expect(classifyAIError({ status: 403, message: 'Forbidden' })).toBe('permission_denied');
  });

  test('classifies content filter', () => {
    expect(classifyAIError({ status: 400, message: 'content policy violation' })).toBe('content_filter');
    expect(classifyAIError(new Error('blocked due to safety'))).toBe('content_filter');
  });

  test('classifies context length', () => {
    expect(classifyAIError({ status: 413 })).toBe('context_length');
    expect(classifyAIError(new Error('maximum context length exceeded'))).toBe('context_length');
  });

  test('classifies server and overloaded errors', () => {
    expect(classifyAIError({ status: 502 })).toBe('api_error');
    expect(classifyAIError({ status: 503 })).toBe('overloaded');
    expect(classifyAIError({ status: 529 })).toBe('overloaded');
  });

  test('classifies client errors and network failures', () => {
    expect(classifyAIError({ status: 418 })).toBe('api_error');
    expect(classifyAIError(new Error('fetch failed'))).toBe('api_error');
  });

  test('reads nested API error messages and string status codes', () => {
    expect(classifyAIError({ status: '429', error: { message: 'Too Many Requests' } })).toBe('rate_limit');
    expect(classifyAIError({ error: { message: 'Rate limit exceeded' } })).toBe('rate_limit');
    expect(classifyAIError('rate limit exceeded')).toBe('rate_limit');
  });

  test('classifies content filter on 400 responses', () => {
    expect(classifyAIError({ status: 400, message: 'blocked due to safety policy' })).toBe('content_filter');
    expect(classifyAIError({ status: 400, message: 'invalid content in request' })).toBe('content_filter');
  });

  test('returns unknown for unrecognized errors', () => {
    expect(classifyAIError(null)).toBe('unknown');
    expect(classifyAIError(new Error('something odd'))).toBe('unknown');
  });
});

describe('classifyAIError provider-specific', () => {
  test('classifies OpenAI quota and auth errors', () => {
    expect(classifyAIError({
      status: 429,
      error: { code: 'insufficient_quota', message: 'You exceeded your current quota' }
    }, 'openai')).toBe('quota_exceeded');
    expect(classifyAIError({
      status: 401,
      error: { code: 'invalid_api_key', type: 'invalid_request_error' }
    }, 'openai')).toBe('auth');
    expect(classifyAIError({ status: 503, message: 'engine is currently overloaded' }, 'openai')).toBe('overloaded');
  });

  test('classifies Claude API error types', () => {
    expect(classifyAIError({ status: 429, error: { type: 'rate_limit_error' } }, 'claude')).toBe('rate_limit');
    expect(classifyAIError({ status: 402, error: { type: 'billing_error' } }, 'claude')).toBe('billing');
    expect(classifyAIError({ status: 529, error: { type: 'overloaded_error' } }, 'claude')).toBe('overloaded');
    expect(classifyAIError({ status: 504, error: { type: 'timeout_error' } }, 'claude')).toBe('timeout');
    expect(classifyAIError({ status: 413, error: { type: 'request_too_large' } }, 'claude')).toBe('context_length');
  });

  test('classifies Gemini RPC status codes', () => {
    expect(classifyAIError({ status: 429, code: 'RESOURCE_EXHAUSTED' }, 'gemini')).toBe('rate_limit');
    expect(classifyAIError({
      status: 429,
      code: 'RESOURCE_EXHAUSTED',
      message: 'Quota exceeded for quota metric'
    }, 'gemini')).toBe('quota_exceeded');
    expect(classifyAIError({ status: 401, code: 'UNAUTHENTICATED' }, 'gemini')).toBe('auth');
    expect(classifyAIError({ status: 403, code: 'PERMISSION_DENIED' }, 'gemini')).toBe('permission_denied');
    expect(classifyAIError({ status: 504, code: 'DEADLINE_EXCEEDED' }, 'gemini')).toBe('timeout');
    expect(classifyAIError({ status: 503, code: 'UNAVAILABLE' }, 'gemini')).toBe('overloaded');
    expect(classifyAIError({ status: 404, code: 'NOT_FOUND' }, 'gemini')).toBe('not_found');
    expect(classifyAIError({ status: 413, code: 'OUT_OF_RANGE' }, 'gemini')).toBe('context_length');
    expect(classifyAIError({ status: 500, code: 'INTERNAL' }, 'gemini')).toBe('api_error');
    expect(classifyAIError({ status: 499, code: 'CANCELLED' }, 'gemini')).toBe('timeout');
    expect(classifyAIError({
      status: 400,
      code: 'INVALID_ARGUMENT',
      message: 'blocked due to safety settings'
    }, 'gemini')).toBe('content_filter');
  });

  test('covers OpenAI-specific branches and generic fallbacks', () => {
    expect(classifyAIError({ status: 403, error: { type: 'permission_denied_error' } }, 'openai')).toBe('permission_denied');
    expect(classifyAIError({ status: 404, error: { code: 'model_not_found' } }, 'openai')).toBe('not_found');
    expect(classifyAIError({ status: 504, error: { type: 'timeout_error' } }, 'openai')).toBe('timeout');
    expect(classifyAIError({ status: 413, error: { code: 'context_length_exceeded' } }, 'openai')).toBe('context_length');
    expect(classifyAIError({ status: 400, error: { type: 'content_filter' } }, 'openai')).toBe('content_filter');
    expect(classifyAIError({ status: 422, message: 'bad json' }, 'openai')).toBe('invalid_request');
    expect(classifyAIError({ status: 500 }, 'openai')).toBe('api_error');
    expect(classifyAIError({ message: 'connection error while fetching' }, 'openai')).toBe('api_error');
    expect(classifyAIError({ status: 429, error: { code: 'rate_limit_exceeded' } }, 'openai')).toBe('rate_limit');
  });

  test('covers Claude invalid_request and generic billing/not_found paths', () => {
    expect(classifyAIError({
      status: 400,
      error: { type: 'invalid_request_error', message: 'prompt is too long' }
    }, 'claude')).toBe('context_length');
    expect(classifyAIError({ status: 402 }, 'claude')).toBe('billing');
    expect(classifyAIError({ status: 404, message: 'model not found' })).toBe('not_found');
    expect(classifyAIError({ status: 402 })).toBe('billing');
    expect(classifyAIError({ status: 422, message: 'bad request' })).toBe('invalid_request');
    expect(classifyAIError({ status: 418 })).toBe('api_error');
    expect(classifyAIError({ message: 'permission denied for resource' })).toBe('permission_denied');
    expect(classifyAIError({ message: 'engine is currently overloaded' })).toBe('overloaded');
    expect(classifyAIError({ message: 'invalid api key provided' })).toBe('auth');
    expect(classifyAIError({ message: 'network error ECONNRESET' })).toBe('api_error');
  });

  test('classifies message and code hints in generic fallback', () => {
    expect(classifyAIError({ error: { code: 'insufficient_quota' } })).toBe('quota_exceeded');
    expect(classifyAIError({ error: { code: 'rate_limit_exceeded' } })).toBe('rate_limit');
    expect(classifyAIError({ code: 'ETIMEDOUT', message: 'failed' })).toBe('timeout');
    expect(classifyAIError({ code: 'ECONNABORTED', message: 'failed' })).toBe('timeout');
    expect(classifyAIError({ error: { code: 'context_length_exceeded' } })).toBe('context_length');
    expect(classifyAIError({ error: { code: 'invalid_api_key' } })).toBe('auth');
    expect(classifyAIError({ error: { code: 'invalid_authentication' } })).toBe('auth');
    expect(classifyAIError({ message: 'permission denied for this resource' })).toBe('permission_denied');
    expect(classifyAIError({ error: { code: 'model_not_found' } })).toBe('not_found');
    expect(classifyAIError({ message: 'service unavailable and overloaded' })).toBe('overloaded');
    expect(classifyAIError({ message: 'You exceeded your current quota' })).toBe('quota_exceeded');
    expect(classifyAIError({ message: 'Rate limit exceeded for this key' })).toBe('rate_limit');
    expect(classifyAIError({ message: 'request timed out waiting for model' })).toBe('timeout');
    expect(classifyAIError({ message: 'permission_error while accessing model' })).toBe('permission_denied');
    expect(classifyAIError({ status: 400, message: 'service overloaded' }, 'openai')).toBe('overloaded');
    expect(classifyAIError({ message: 'billing exceeded your current quota' })).toBe('quota_exceeded');
    expect(classifyAIError({ message: 'too many requests please slow down' })).toBe('rate_limit');
    expect(classifyAIError({ message: 'deadline exceeded for this call' })).toBe('timeout');
    expect(classifyAIError({
      status: 400,
      error: { type: 'invalid_request_error' },
      message: 'engine is currently overloaded'
    }, 'claude')).toBe('overloaded');
    expect(classifyAIError({ error: { status: 'UNAVAILABLE' } }, 'gemini')).toBe('overloaded');
    expect(classifyAIError({
      error: { code: 'RESOURCE_EXHAUSTED', statusCode: 'DEADLINE_EXCEEDED' }
    }, 'gemini')).toBe('rate_limit');
    expect(classifyAIError({ message: 'rate limit exceeded for requests' }, 'openai')).toBe('rate_limit');
    expect(classifyAIError({ message: 'deadline exceeded for this call' }, 'openai')).toBe('timeout');
    expect(classifyAIError({ status: 429, message: 'quota billing limit reached' })).toBe('quota_exceeded');
    expect(classifyAIError({ status: 429, message: 'rate limit only' })).toBe('rate_limit');
    expect(classifyAIError({ error: { type: 'rate_limit_error' } }, 'claude')).toBe('rate_limit');
    expect(classifyAIError({ status: 400, error: { type: 'invalid_request_error' }, message: 'bad field' }, 'claude')).toBe('invalid_request');
    expect(classifyAIError({ error: { type: 'authentication_error' } }, 'claude')).toBe('auth');
    expect(classifyAIError({ error: { status: 'INTERNAL' } }, 'gemini')).toBe('api_error');
    expect(classifyAIError({ message: 'no matching provider hints' }, 'gemini')).toBe('unknown');
    expect(classifyAIError({ error: { type: 'permission_error' } }, 'claude')).toBe('permission_denied');
    expect(classifyAIError({ error: { type: 'not_found_error' } }, 'claude')).toBe('not_found');
    expect(classifyAIError({ error: { type: 'api_error' } }, 'claude')).toBe('api_error');
    expect(classifyAIError({ type: 'not_found_error' }, 'claude')).toBe('not_found');
    expect(classifyAIError({ status: 400, code: 'INVALID_ARGUMENT', message: 'bad field' }, 'gemini')).toBe('invalid_request');
    expect(classifyAIError({ status: 429, code: 'RESOURCE_EXHAUSTED', message: 'plain rate limit' }, 'gemini')).toBe('rate_limit');
    expect(classifyAIError({ error: 'not-an-object' }, 'gemini')).toBe('unknown');
    expect(classifyAIError({ status: 500 }, 'claude')).toBe('api_error');
    expect(classifyAIError({ type: 'error' }, 'claude')).toBe('unknown');
    expect(classifyAIError({ error: { type: 123 } }, 'claude')).toBe('unknown');
    expect(classifyAIError({ error: { status: '404' } }, 'gemini')).toBe('unknown');
    expect(classifyAIError('rate limit exceeded', 'gemini')).toBe('rate_limit');
    expect(classifyAIError(null, 'openai')).toBe('unknown');
  });

  test('ignores unknown provider aliases and uses generic messages', () => {
    expect(classifyAIError({ status: 429 }, 'unknown-vendor')).toBe('rate_limit');
    expect(formatAIUserMessage({ reason: 'rate_limit', provider: 'unknown-vendor' })).toContain('busy');
    expect(classifyAIError({ status: 429 }, 'anthropic')).toBe('rate_limit');
    expect(classifyAIError({ status: 429 }, 'google')).toBe('rate_limit');
  });
});

describe('formatAIUserMessage', () => {
  test('prefixes messages with warning emoji', () => {
    expect(formatAIUserMessage({ reason: 'empty_response' })).toMatch(/^⚠️ /);
  });

  test('uses explicit reason when provided', () => {
    expect(formatAIUserMessage({ reason: 'rate_limit' })).toContain('busy');
  });

  test('classifies from error when reason omitted', () => {
    expect(formatAIUserMessage({ error: { status: 429 } })).toContain('busy');
  });

  test('uses provider-specific copy for OpenAI', () => {
    expect(formatAIUserMessage({
      error: { status: 429, error: { code: 'insufficient_quota' } },
      provider: 'openai'
    })).toContain('OpenAI quota exceeded');
  });

  test('uses provider-specific copy for Claude', () => {
    expect(formatAIUserMessage({
      error: { status: 529, error: { type: 'overloaded_error' } },
      provider: 'claude'
    })).toContain('Claude is temporarily overloaded');
  });

  test('uses provider-specific copy for Gemini', () => {
    expect(formatAIUserMessage({
      error: { status: 401, code: 'UNAUTHENTICATED' },
      provider: 'gemini'
    })).toContain('Gemini authentication failed');
  });

  test('uses provider-specific missing key messages', () => {
    expect(formatAIUserMessage({ reason: 'missing_api_key', provider: 'openai' })).toContain('OPENAI_API_KEY');
    expect(formatAIUserMessage({ reason: 'missing_api_key', provider: 'claude' })).toContain('ANTHROPIC_API_KEY');
    expect(formatAIUserMessage({ reason: 'missing_api_key', provider: 'gemini' })).toContain('GEMINI_API_KEY');
  });

  test('defaults to unknown when no reason or error is given', () => {
    expect(formatAIUserMessage({})).toContain('Something went wrong');
  });

  test('falls back to unknown body for unrecognized reasons', () => {
    expect(formatAIUserMessage({ reason: 'not_a_real_reason' })).toContain('Something went wrong');
  });

  test('does not leak stack traces', () => {
    const err = new Error('secret internal detail');
    err.stack = 'Error: secret\n    at sensitive.js:1:1';
    const msg = formatAIUserMessage({ error: err, provider: 'openai' });
    expect(msg).not.toContain('sensitive.js');
    expect(msg).not.toContain('at ');
  });
});

describe('isAIUserErrorMessage', () => {
  test('detects formatted error replies', () => {
    expect(isAIUserErrorMessage(formatAIUserMessage({ reason: 'api_error' }))).toBe(true);
    expect(isAIUserErrorMessage('Hello')).toBe(false);
    expect(isAIUserErrorMessage('')).toBe(false);
  });
});
