const { OpenAI } = require('openai');
const { GoogleGenAI } = require('@google/genai');
const Anthropic = require('@anthropic-ai/sdk');
const {
  openaiApiKey,
  geminiApiKey,
  anthropicApiKey,
  modelName,
  backupModels,
  reasoningEffort,
  responsesVerbosity,
  aiProvider,
  enableWebSearch,
  enableGoogleMaps,
  maxOutputTokens,
  enableContextCache,
  geminiCacheTtlSeconds,
  claudeThinkingBudgetTokens,
  claudeEffort,
  claudeCacheMinTokens,
  geminiSafetySettings,
  openaiTimeoutMs,
  openaiMaxRetries,
  geminiTimeoutMs,
  claudeTimeoutMs
} = require('../config');
const { captureError, recordCount, recordDistribution, startSpan } = require('../instrument');
const path = require('path');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('./logSanitize');
const {
  hasImages,
  SYSTEM_MESSAGES,
  estimateTokensFromText,
  formatAIUserMessage,
  isAIUserErrorMessage,
  normalizeConversationRoles,
  classifyAIError,
  isBusyAIErrorReason
} = require('./aiUtils');

/**
 * @param {unknown} error
 * @returns {error is ProviderBusyError}
 */
function isProviderBusyError(error) {
  return error instanceof ProviderBusyError || error?.name === 'ProviderBusyError';
}

class ProviderBusyError extends Error {
  /**
   * @param {unknown} cause
   * @param {string} reason
   * @param {string} attemptedModel
   */
  constructor(cause, reason, attemptedModel) {
    super(cause instanceof Error ? cause.message : 'Provider busy');
    this.name = 'ProviderBusyError';
    this.cause = cause;
    this.reason = reason;
    this.attemptedModel = attemptedModel;
  }
}

/**
 * @param {unknown} apiError
 * @param {string} provider
 * @param {string} attemptedModel
 */
function rethrowIfBusyForBackup(apiError, provider, attemptedModel) {
  if (isProviderBusyError(apiError)) throw apiError;
  const reason = classifyAIError(apiError, provider);
  if ((backupModels ?? []).length > 0 && isBusyAIErrorReason(reason)) {
    throw new ProviderBusyError(apiError, reason, attemptedModel);
  }
}

function prepareConversationForApi(conversation) {
  const copy = conversation.map(msg => ({
    role: msg.role,
    content: Array.isArray(msg.content)
      ? msg.content.map(part => ({ ...part }))
      : msg.content
  }));
  return normalizeConversationRoles(copy);
}

/** Gemini context cache minimum token count (API requirement; Flash 1024, Pro 4096). */
const GEMINI_MIN_CACHE_TOKENS = 1024;

/**
 * Gemini 3+ models think by default and thinking tokens count against maxOutputTokens, so a small
 * cap can return empty text. Headroom keeps replies intact; the non-streaming cap on Gemini 4
 * Carbon/Argon is 32,768 tokens.
 */
const GEMINI_THINKING_HEADROOM_TOKENS = 8192;
const GEMINI_MAX_OUTPUT_TOKENS = 32768;

/** Image types Gemini documents for inline input (GIF is not among them). */
const GEMINI_INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);

/** Stable key so OpenAI routes repeat requests to cache-friendly servers (OpenAI caches automatically). */
const OPENAI_PROMPT_CACHE_KEY = 'ai-bot-system-v1';

/**
 * Lowest reasoning effort each OpenAI model accepts, where that isn't 'none'
 * (developers.openai.com model pages, 2026-11-12). Lower configured values are raised to it.
 */
const OPENAI_MIN_REASONING_EFFORT = {
  'gpt-6-astra': 'low',
  'gpt-6.1-sol': 'low',
  'gpt-5.5-pro': 'medium',
  'gpt-5.4-pro': 'medium',
  'gpt-5.2-pro': 'medium'
};
const OPENAI_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];

/** Models documented to accept prompt_cache_retention '24h' (newer models default to a 30m cache). */
const OPENAI_EXTENDED_CACHE_MODELS = new Set(['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.2']);

/**
 * Reasoning tokens count against max_output_tokens; OpenAI recommends reserving ~25k when reasoning
 * so replies aren't cut off (status "incomplete"). The cap is a ceiling, not a charge.
 */
const OPENAI_REASONING_HEADROOM_TOKENS = 25000;
const OPENAI_MAX_OUTPUT_TOKENS = 128000;

/**
 * Configured effort, raised to the model's minimum. Invalid or empty values count as 'none' so a
 * model's own default (often 'medium') never silently applies.
 * @param {string} model
 * @param {string} configured
 * @returns {string}
 */
function resolveOpenAIReasoningEffort(model, configured) {
  const normalized = typeof configured === 'string' ? configured.trim().toLowerCase() : '';
  const effort = OPENAI_REASONING_EFFORTS.includes(normalized) ? normalized : 'none';
  const minimum = OPENAI_MIN_REASONING_EFFORT[model];
  if (minimum && OPENAI_REASONING_EFFORTS.indexOf(effort) < OPENAI_REASONING_EFFORTS.indexOf(minimum)) {
    return minimum;
  }
  return effort;
}

/** Rough per-image token estimate for Claude prefix sizing (a ~1024px image is ~1,400 tokens). */
const CLAUDE_ESTIMATED_TOKENS_PER_IMAGE = 1400;

/**
 * Highest max_tokens sent on a non-streaming Claude request. The Anthropic SDK refuses non-streaming
 * requests whose max_tokens implies more than ~10 minutes of generation (about 21k tokens).
 */
const CLAUDE_MAX_NONSTREAMING_TOKENS = 20000;

/** Extra max_tokens headroom for Claude models that think, when no budget is configured. */
const CLAUDE_DEFAULT_THINKING_HEADROOM = 8192;

/**
 * Normalized token usage. `inputTokens` is the full prompt including cached tokens.
 * @typedef {{ inputTokens?: number, outputTokens?: number, cachedInputTokens?: number,
 *   cacheWriteTokens?: number, reasoningTokens?: number }} TokenUsage
 */

/** @param {*} value */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * @param {*} usage - OpenAI Responses `response.usage`
 * @returns {TokenUsage|null}
 */
function normalizeOpenAIUsage(usage) {
  if (!usage) return null;
  return {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cachedInputTokens: tokenCount(usage.input_tokens_details?.cached_tokens),
    reasoningTokens: tokenCount(usage.output_tokens_details?.reasoning_tokens)
  };
}

/**
 * @param {*} usage - Gemini `response.usageMetadata`
 * @returns {TokenUsage|null}
 */
function normalizeGeminiUsage(usage) {
  if (!usage) return null;
  const prompt = tokenCount(usage.promptTokenCount);
  const toolPrompt = tokenCount(usage.toolUsePromptTokenCount);
  return {
    inputTokens: (prompt || 0) + (toolPrompt || 0),
    outputTokens: tokenCount(usage.candidatesTokenCount),
    cachedInputTokens: tokenCount(usage.cachedContentTokenCount),
    reasoningTokens: tokenCount(usage.thoughtsTokenCount)
  };
}

/**
 * Adds one Claude response's usage (possibly one of several tool rounds) into a running total.
 * Claude reports uncached input separately from cache reads and writes; all three are prompt tokens.
 * @param {TokenUsage|null} total
 * @param {*} usage - Claude `response.usage`
 * @returns {TokenUsage|null}
 */
function addClaudeUsage(total, usage) {
  if (!usage) return total;
  const cacheRead = tokenCount(usage.cache_read_input_tokens) || 0;
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens) || 0;
  const input = (tokenCount(usage.input_tokens) || 0) + cacheRead + cacheWrite;
  const base = total || { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  return {
    inputTokens: base.inputTokens + input,
    outputTokens: base.outputTokens + (tokenCount(usage.output_tokens) || 0),
    cachedInputTokens: base.cachedInputTokens + cacheRead,
    cacheWriteTokens: base.cacheWriteTokens + cacheWrite
  };
}

const TOKEN_METRIC_NAMES = {
  inputTokens: 'ai.tokens.input',
  outputTokens: 'ai.tokens.output',
  cachedInputTokens: 'ai.tokens.cached_input',
  cacheWriteTokens: 'ai.tokens.cache_write',
  reasoningTokens: 'ai.tokens.reasoning'
};

/**
 * Logs and records token usage for one provider call so spend can be measured per provider/model.
 * @param {string} provider
 * @param {string} model
 * @param {TokenUsage|null} usage
 */
function recordTokenUsage(provider, model, usage) {
  if (!usage) return;
  const counts = Object.fromEntries(
    Object.entries(usage).filter(([, value]) => typeof value === 'number')
  );
  if (Object.keys(counts).length === 0) return;
  logger.info('AI token usage.', { provider, model, ...counts });
  for (const [key, value] of Object.entries(counts)) {
    const metricName = TOKEN_METRIC_NAMES[key];
    if (metricName) {
      recordDistribution(metricName, value, { attributes: { provider, model } });
    }
  }
}

/**
 * Rough token estimate for a Claude system prompt plus messages (used to decide whether caching pays off).
 * @param {string|undefined} system
 * @param {Array<{content: string|Array}>} messages
 * @returns {number}
 */
function estimateClaudePromptTokens(system, messages) {
  let total = estimateTokensFromText(system);
  for (const msg of messages) {
    const blocks = typeof msg.content === 'string' ? [{ text: msg.content }] : msg.content;
    for (const block of blocks) {
      total += block.type === 'image' ? CLAUDE_ESTIMATED_TOKENS_PER_IMAGE : estimateTokensFromText(block.text);
    }
  }
  return total;
}

/**
 * Marks the message before the latest user turn for Claude prompt-cache reuse. One breakpoint caches
 * the whole prefix (system + earlier turns), so the system prompt needs no breakpoint of its own.
 * @param {Array<{role: string, content: string|Array}>} messages - Claude-format messages
 * @returns {Array<{role: string, content: string|Array}>}
 */
function applyConversationCacheBreakpoints(messages) {
  const breakpointIdx = messages.length - 2;
  if (breakpointIdx < 0 || messages[messages.length - 1].role !== 'user') return messages;
  return messages.map((msg, idx) => (idx === breakpointIdx ? markMessageForPromptCache(msg) : msg));
}

/**
 * @param {{ role: string, content: string|Array }} message
 * @returns {{ role: string, content: string|Array }}
 */
function markMessageForPromptCache(message) {
  const cacheControl = { type: 'ephemeral' };
  if (typeof message.content === 'string') {
    return {
      ...message,
      content: [{ type: 'text', text: message.content, cache_control: cacheControl }]
    };
  }
  // Thinking blocks can't carry cache_control; mark the last block that can.
  let marked = false;
  const content = [...message.content].reverse().map(part => {
    if (!marked && part.type !== 'thinking' && part.type !== 'redacted_thinking') {
      marked = true;
      return { ...part, cache_control: cacheControl };
    }
    return part;
  }).reverse();
  return { ...message, content };
}

/**
 * OpenAI client instance configured with API key, timeout, and retries (used when aiProvider === 'openai').
 * @type {OpenAI}
 */
const openai = openaiApiKey
  ? new OpenAI({
      apiKey: openaiApiKey,
      timeout: openaiTimeoutMs,
      maxRetries: openaiMaxRetries
    })
  : null;

/**
 * Google GenAI client (used when aiProvider === 'gemini').
 * @type {GoogleGenAI|null}
 */
const genAI = geminiApiKey ? new GoogleGenAI({
  apiKey: geminiApiKey,
  // @google/genai 3.x defaults to v1; preview models, context caching and grounding tools need v1beta.
  // GOOGLE_GENAI_API_VERSION still wins when set.
  ...(process.env.GOOGLE_GENAI_API_VERSION ? {} : { apiVersion: 'v1beta' })
}) : null;

/**
 * Anthropic client (used when aiProvider === 'claude').
 * @type {Anthropic|null}
 */
const anthropic = anthropicApiKey
  ? new Anthropic({ apiKey: anthropicApiKey, timeout: claudeTimeoutMs })
  : null;

/**
 * Rejects when a provider request exceeds the configured timeout.
 * @param {Promise<*>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<*>}
 */
function withRequestTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} request timed out after ${timeoutMs}ms.`));
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

/** Placeholder user turn when history would otherwise start with an assistant/model turn. */
const EARLIER_CONVERSATION_MARKER = '[Earlier conversation]';

/** In-memory Gemini context cache: one entry for system instruction (reused across channels). */
let geminiCacheEntry = null;

/** Claude Haiku 4.5: thinking only via `{ type: 'enabled', budget_tokens }`. */
const CLAUDE_BUDGET_THINKING_MODELS = ['claude-haiku-4-5'];

/**
 * Claude 4.6-4.8: adaptive thinking, off unless requested (`budget_tokens` is deprecated on 4.6 and
 * rejected on 4.7+). Every newer model (Claude 5 family, Fable) thinks adaptively by default, and
 * several reject attempts to disable it, so for those the request sends no `thinking` field at all.
 */
const CLAUDE_OPTIONAL_ADAPTIVE_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-4-8'];

/**
 * @param {string} model
 * @returns {'budget'|'optional'|'always'}
 */
function claudeThinkingMode(model) {
  const id = model;
  if (CLAUDE_BUDGET_THINKING_MODELS.some(m => id.startsWith(m))) return 'budget';
  if (CLAUDE_OPTIONAL_ADAPTIVE_MODELS.some(m => id.startsWith(m))) return 'optional';
  return 'always';
}

/**
 * Maps CLAUDE_EFFORT onto what the model accepts (or null to omit `output_config.effort`).
 * @param {string} model
 * @param {string|null} effort
 * @returns {string|null}
 */
function claudeEffortFor(model, effort) {
  if (!effort) return null;
  const id = model;
  // Haiku 4.5 rejects effort; the 4.6 models have no xhigh level.
  if (id.startsWith('claude-haiku-4-5')) return null;
  if (id.startsWith('claude-opus-4-6') || id.startsWith('claude-sonnet-4-6')) return effort === 'xhigh' ? 'high' : effort;
  return effort;
}

/**
 * Builds the thinking, effort and max_tokens fields of a Claude request.
 * @param {string} model
 * @returns {{ thinking?: object, outputConfig?: object, maxTokens: number }}
 */
function buildClaudeThinkingParams(model) {
  const mode = claudeThinkingMode(model);
  const requested = claudeThinkingBudgetTokens > 0;
  const result = { maxTokens: Math.min(CLAUDE_MAX_NONSTREAMING_TOKENS, maxOutputTokens) };

  if (mode === 'budget' && requested) {
    result.maxTokens = Math.min(CLAUDE_MAX_NONSTREAMING_TOKENS, maxOutputTokens + claudeThinkingBudgetTokens);
    // budget_tokens must be >= 1024 and below max_tokens, leaving some room for the reply.
    const budget = Math.max(1024, Math.min(claudeThinkingBudgetTokens, result.maxTokens - 256));
    result.thinking = { type: 'enabled', budget_tokens: budget };
  } else if ((mode === 'optional' && requested) || mode === 'always') {
    const headroom = requested ? claudeThinkingBudgetTokens : CLAUDE_DEFAULT_THINKING_HEADROOM;
    result.maxTokens = Math.min(CLAUDE_MAX_NONSTREAMING_TOKENS, maxOutputTokens + headroom);
    if (mode === 'optional') result.thinking = { type: 'adaptive' };
  }

  const effort = claudeEffortFor(model, claudeEffort);
  if (effort) result.outputConfig = { effort };
  return result;
}

/** Claude tools: optional tools the model can call. */
const CLAUDE_TOOLS = [
  {
    name: 'get_current_time',
    description: 'Returns the current date and time in ISO 8601 format (UTC). Use when the user asks for the current time, date, or "now".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

/**
 * Executes a Claude tool by name and returns the result string.
 * @param {string} name - Tool name
 * @param {Object} _input - Tool input
 * @returns {string} Result to send back to Claude
 */
function executeClaudeTool(name, _input) {
  if (name === 'get_current_time') {
    return new Date().toISOString();
  }
  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

const TIME_QUERY_PATTERN = /\b(?:what(?:'s| is) the time|what time is it|current time|what(?:'s| is) the date|today'?s date|what day is (?:it|today)|tell me the (?:time|date))\b/i;

/**
 * Extract plain text from the last user message in a conversation.
 * @param {Array<{role: string, content: string|Array}>} conversation
 * @returns {string}
 */
function getLastUserMessageText(conversation) {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const msg = conversation[i];
    if (msg.role !== 'user') continue;
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(item => item && item.type === 'input_text' && typeof item.text === 'string')
        .map(item => item.text)
        .join(' ');
    }
    return '';
  }
  return '';
}

/**
 * Returns true when the latest user message likely needs the time tool.
 * @param {Array<{role: string, content: string|Array}>} conversation
 * @returns {boolean}
 */
function conversationMentionsTime(conversation) {
  const text = getLastUserMessageText(conversation);
  return Boolean(text && TIME_QUERY_PATTERN.test(text));
}

/**
 * Parses a data URL (e.g. data:image/png;base64,XXX) into mimeType and base64 data for Gemini.
 * @param {string} dataUrl - data URL string
 * @returns {{ mimeType: string, data: string }|null}
 */
function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1].trim(), data: match[2].trim() };
}

/**
 * Converts internal conversation format to Gemini API contents and systemInstruction.
 * @param {Array<{role: string, content: string|Array}>} conversation - Internal conversation messages
 * @returns {{ systemInstruction: string|undefined, contents: Array<{ role: string, parts: Array }> }}
 */
function conversationToGeminiFormat(conversation) {
  let systemInstruction;
  const contents = [];

  for (const msg of conversation) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.trim()) systemInstruction = text;
      continue;
    }

    if (msg.role === 'user') {
      const parts = [];
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === 'input_text' && typeof item.text === 'string' && item.text.trim()) {
            parts.push({ text: item.text.trim() });
          }
          if (item.type === 'input_image') {
            const parsed = parseDataUrl(item.image_url);
            if (parsed && GEMINI_INLINE_IMAGE_TYPES.has(parsed.mimeType.toLowerCase())) {
              parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
            } else if (parsed) {
              parts.push({ text: `[An attached ${parsed.mimeType} image could not be analyzed.]` });
            }
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        parts.push({ text: content.trim() });
      }
      if (parts.length > 0) contents.push({ role: 'user', parts });
      continue;
    }

    if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.trim()) contents.push({ role: 'model', parts: [{ text: text.trim() }] });
    }
  }

  // Newer Gemini models return 400 when the request ends on a model turn, and the first turn must
  // be a user turn (a reply to the bot can start history with the bot's own message).
  while (contents.length > 0 && contents[contents.length - 1].role === 'model') contents.pop();
  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: EARLIER_CONVERSATION_MARKER }] });
  }

  return { systemInstruction, contents };
}

/**
 * Converts internal conversation format to Claude API system and messages.
 * @param {Array<{role: string, content: string|Array}>} conversation - Internal conversation messages
 * @returns {{ system: string|undefined, messages: Array<{ role: string, content: string|Array }> }}
 */
function conversationToClaudeFormat(conversation) {
  let system;
  const messages = [];

  for (const msg of conversation) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.trim()) system = text;
      continue;
    }

    if (msg.role === 'user') {
      const content = msg.content;
      if (Array.isArray(content)) {
        const blocks = [];
        for (const item of content) {
          if (item.type === 'input_text' && typeof item.text === 'string' && item.text.trim()) {
            blocks.push({ type: 'text', text: item.text.trim() });
          }
          if (item.type === 'input_image' && item.image_url) {
            const parsed = parseDataUrl(item.image_url);
            if (parsed) {
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: parsed.mimeType, data: parsed.data }
              });
            }
          }
        }
        if (blocks.length > 0) messages.push({ role: 'user', content: blocks });
      } else if (typeof content === 'string' && content.trim()) {
        messages.push({ role: 'user', content: content.trim() });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.trim()) messages.push({ role: 'assistant', content: text.trim() });
    }
  }

  // Claude rejects a trailing assistant turn (prefill) on 4.6+ models and requires the first
  // message to be a user turn (a reply to the bot can start history with the bot's own message).
  while (messages.length > 0 && messages[messages.length - 1].role === 'assistant') messages.pop();
  if (messages.length > 0 && messages[0].role === 'assistant') {
    messages.unshift({ role: 'user', content: EARLIER_CONVERSATION_MARKER });
  }

  return { system, messages };
}

/**
 * Generates an AI response using the Gemini API.
 * @param {Array<{role: string, content: string|Array}>} conversation - Conversation history
 * @returns {Promise<string>} Generated reply or empty string on failure
 */
async function generateGeminiResponse(conversation, activeModel = modelName) {
  const startedAt = Date.now();
  if (!genAI) {
    logger.error('Gemini API key not configured (GEMINI_API_KEY).');
    return formatAIUserMessage({ reason: 'missing_api_key', provider: 'gemini' });
  }

  const { systemInstruction, contents } = conversationToGeminiFormat(conversation);
  if (contents.length === 0) {
    logger.error('No valid user/model turns for Gemini.');
    return formatAIUserMessage({ reason: 'api_error' });
  }

  let systemWithImageHint = systemInstruction;
  if (hasImages(conversation) && systemInstruction) {
    systemWithImageHint = systemInstruction + '\n\n' + SYSTEM_MESSAGES.IMAGE_ANALYSIS;
  } else if (hasImages(conversation)) {
    systemWithImageHint = SYSTEM_MESSAGES.IMAGE_ANALYSIS;
  }

  // No temperature: Gemini 3+ deprecates sampling parameters (Gemini 4 ignores them), and the bot
  // only ever sent the default.
  const config = {
    maxOutputTokens: Math.min(GEMINI_MAX_OUTPUT_TOKENS, maxOutputTokens + GEMINI_THINKING_HEADROOM_TOKENS)
  };

  let useCachedContent = false;
  const systemTokenEstimate = systemWithImageHint ? estimateTokensFromText(systemWithImageHint) : 0;
  const meetsMinForCache = systemTokenEstimate >= GEMINI_MIN_CACHE_TOKENS;

  // Gemini 4 models reject explicit caching (implicit caching applies automatically).
  const supportsExplicitCache = !activeModel.startsWith('gemini-4');
  if (enableContextCache && systemWithImageHint && genAI.caches && meetsMinForCache && supportsExplicitCache) {
    const now = Date.now();
    if (geminiCacheEntry && geminiCacheEntry.systemInstruction === systemWithImageHint && geminiCacheEntry.expiresAt > now) {
      config.cachedContent = geminiCacheEntry.name;
      useCachedContent = true;
    } else {
      try {
        const cache = await genAI.caches.create({
          model: activeModel,
          config: {
            systemInstruction: systemWithImageHint,
            ttl: `${geminiCacheTtlSeconds}s`,
            displayName: 'ai-bot-system'
          }
        });
        const expiresAt = now + geminiCacheTtlSeconds * 1000;
        geminiCacheEntry = { name: cache.name, expiresAt, systemInstruction: systemWithImageHint };
        config.cachedContent = cache.name;
        useCachedContent = true;
        logger.debug('Created Gemini context cache.', { name: cache.name, ttlSeconds: geminiCacheTtlSeconds });
      } catch (cacheErr) {
        logger.warn('Gemini context cache creation failed, falling back to uncached.', {
          message: cacheErr?.message
        });
        config.systemInstruction = systemWithImageHint;
      }
    }
  }
  if (!useCachedContent && systemWithImageHint) config.systemInstruction = systemWithImageHint;
  // Gemini API: google_search and google_maps cannot be used in the same request (400 INVALID_ARGUMENT).
  let geminiUseWebSearch = enableWebSearch;
  let geminiUseMaps = enableGoogleMaps;
  if (enableWebSearch && enableGoogleMaps) {
    geminiUseMaps = false;
    logger.warn(
      'ENABLE_WEB_SEARCH and ENABLE_GOOGLE_MAPS are both on; Gemini allows only one per request. Using Google Search grounding only. Disable ENABLE_WEB_SEARCH to use Maps.'
    );
  }
  if (geminiUseWebSearch || geminiUseMaps) {
    config.tools = [];
    if (geminiUseWebSearch) config.tools.push({ googleSearch: {} });
    if (geminiUseMaps) config.tools.push({ googleMaps: {} });
  }
  if (geminiSafetySettings && geminiSafetySettings.length > 0) {
    config.safetySettings = geminiSafetySettings;
  }

  logger.debug(`Sending conversation to Gemini API using model ${activeModel}.`, {
    messageCount: conversation.length,
    model: activeModel,
    contentsLength: contents.length,
    searchGrounding: geminiUseWebSearch,
    mapsGrounding: geminiUseMaps,
    hasImages: hasImages(conversation),
    usingContextCache: useCachedContent,
    safetySettings: config.safetySettings ? config.safetySettings.length : 0
  });

  let response;
  try {
    response = await withRequestTimeout(
      genAI.models.generateContent({
        model: activeModel,
        contents: contents,
        config
      }),
      geminiTimeoutMs,
      'Gemini'
    );
    recordTokenUsage('gemini', activeModel, normalizeGeminiUsage(response?.usageMetadata));

    const text = (typeof response?.text === 'function' ? response.text() : response?.text) ?? '';
    if (!text || !text.trim()) {
      logger.warn('Gemini response is empty.', {
        provider: 'gemini',
        model: activeModel,
        inputMessageCount: conversation.length,
        durationMs: Date.now() - startedAt,
        outcome: 'empty'
      });
      return formatAIUserMessage({ reason: 'empty_response' });
    }

    logger.info('Generated AI response successfully (Gemini).', {
      provider: 'gemini',
      model: activeModel,
      charCount: text.length,
      inputMessageCount: conversation.length,
      hasImages: hasImages(conversation),
      durationMs: Date.now() - startedAt,
      outcome: 'success'
    });
    return text.trim();
  } catch (apiError) {
    const errMsg = typeof apiError?.message === 'string' ? apiError.message : '';
    const isLikelyStaleCache = useCachedContent && (
      apiError?.status === 404 ||
      apiError?.code === 404 ||
      (/cachedcontent|cached.?content/i.test(errMsg) && /not\s*found|NOT_FOUND|expired|was\s+deleted/i.test(errMsg))
    );
    if (isLikelyStaleCache) {
      geminiCacheEntry = null;
      logger.warn('Gemini cached content likely expired or invalid, retrying without cache.', {
        message: apiError?.message
      });
      const retryConfig = { ...config };
      delete retryConfig.cachedContent;
      if (systemWithImageHint) retryConfig.systemInstruction = systemWithImageHint;
      try {
        response = await withRequestTimeout(
          genAI.models.generateContent({
            model: activeModel,
            contents: contents,
            config: retryConfig
          }),
          geminiTimeoutMs,
          'Gemini'
        );
        recordTokenUsage('gemini', activeModel, normalizeGeminiUsage(response?.usageMetadata));
        const retryText = (typeof response?.text === 'function' ? response.text() : response?.text) ?? '';
        if (retryText && retryText.trim()) {
          logger.info('Generated AI response successfully (Gemini, retry without cache).', {
            provider: 'gemini',
            model: activeModel,
            charCount: retryText.length,
            durationMs: Date.now() - startedAt,
            outcome: 'success'
          });
          return retryText.trim();
        }
      } catch (retryErr) {
        rethrowIfBusyForBackup(retryErr, 'gemini', activeModel);
        captureError(retryErr, { provider: 'gemini', handler: 'retryWithoutCache' });
        logger.error('Gemini API retry without cache failed.', {
          provider: 'gemini',
          model: activeModel,
          durationMs: Date.now() - startedAt,
          outcome: 'error',
          ...serializeError(retryErr, { includeStack: true })
        });
        return formatAIUserMessage({ error: retryErr, provider: 'gemini' });
      }
      return formatAIUserMessage({ reason: 'empty_response' });
    }
    rethrowIfBusyForBackup(apiError, 'gemini', activeModel);
    captureError(apiError, { provider: 'gemini' });
    logger.error('Gemini API request failed.', {
      provider: 'gemini',
      model: activeModel,
      durationMs: Date.now() - startedAt,
      outcome: 'error',
      ...serializeError(apiError, { includeStack: true })
    });
    return formatAIUserMessage({ error: apiError, provider: 'gemini' });
  }
}

/**
 * Generates an AI response using the Claude (Anthropic) API.
 * @param {Array<{role: string, content: string|Array}>} conversation - Conversation history
 * @returns {Promise<string>} Generated reply or empty string on failure
 */
async function generateClaudeResponse(conversation, activeModel = modelName) {
  const startedAt = Date.now();
  if (!anthropic) {
    logger.error('Anthropic API key not configured (ANTHROPIC_API_KEY).');
    return formatAIUserMessage({ reason: 'missing_api_key', provider: 'claude' });
  }

  const { system, messages } = conversationToClaudeFormat(conversation);
  if (messages.length === 0) {
    logger.error('No valid user/assistant turns for Claude.');
    return formatAIUserMessage({ reason: 'api_error' });
  }

  let systemWithImageHint = system;
  if (hasImages(conversation) && system) {
    systemWithImageHint = system + '\n\n' + SYSTEM_MESSAGES.IMAGE_ANALYSIS;
  } else if (hasImages(conversation)) {
    systemWithImageHint = SYSTEM_MESSAGES.IMAGE_ANALYSIS;
  }

  const thinkingParams = buildClaudeThinkingParams(activeModel);
  // No sampling params: Anthropic API version 2026-10-21 (SDK >= 1.0) rejects temperature/top_p/top_k with a 400.
  const params = {
    model: activeModel,
    max_tokens: thinkingParams.maxTokens
  };
  if (systemWithImageHint) params.system = systemWithImageHint;
  if (thinkingParams.thinking) params.thinking = thinkingParams.thinking;
  if (thinkingParams.outputConfig) params.output_config = thinkingParams.outputConfig;

  if (conversationMentionsTime(conversation)) {
    params.tools = CLAUDE_TOOLS;
  }

  // Cache writes cost 1.25x input and expire after 5 minutes, so only mark prompts large enough
  // for later turns to plausibly re-read them. Small prefixes fall below Claude's cache minimum anyway.
  const promptCacheActive = enableContextCache
    && estimateClaudePromptTokens(systemWithImageHint, messages) >= claudeCacheMinTokens;

  logger.debug(`Sending conversation to Claude API using model ${activeModel}.`, {
    messageCount: conversation.length,
    model: activeModel,
    messagesLength: messages.length,
    hasImages: hasImages(conversation),
    promptCacheActive,
    thinking: params.thinking?.type,
    effort: params.output_config?.effort
  });

  let usageTotal = null;
  // Billed tokens (including earlier tool rounds) are recorded on every exit path.
  const finish = value => {
    recordTokenUsage('claude', activeModel, usageTotal);
    return value;
  };
  try {
    let currentMessages = [...messages];
    const maxToolRounds = 5;
    let round = 0;
    let response;

    while (round < maxToolRounds) {
      const roundMessages = promptCacheActive
        ? applyConversationCacheBreakpoints(currentMessages)
        : currentMessages;
      response = await withRequestTimeout(
        anthropic.messages.create({ ...params, messages: roundMessages }),
        claudeTimeoutMs,
        'Claude'
      );
      usageTotal = addClaudeUsage(usageTotal, response.usage);

      const toolUseBlocks = (response.content || []).filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) {
        const textBlock = response.content && response.content.find(b => b.type === 'text');
        const text = (textBlock && textBlock.text && textBlock.text.trim()) ? textBlock.text.trim() : '';
        if (!text) {
          logger.warn('Claude response is empty.', {
            provider: 'claude',
            model: activeModel,
            toolRounds: round,
            durationMs: Date.now() - startedAt,
            outcome: 'empty'
          });
          return finish(formatAIUserMessage({ reason: 'empty_response' }));
        }
        logger.info('Generated AI response successfully (Claude).', {
          provider: 'claude',
          model: activeModel,
          charCount: text.length,
          toolRounds: round,
          inputMessageCount: conversation.length,
          durationMs: Date.now() - startedAt,
          outcome: 'success'
        });
        return finish(text);
      }

      const toolResults = toolUseBlocks.map(block => ({
        type: 'tool_result',
        tool_use_id: block.id,
        content: executeClaudeTool(block.name, block.input || {})
      }));

      currentMessages.push({ role: 'assistant', content: response.content });
      currentMessages.push({ role: 'user', content: toolResults });
      round++;
      logger.debug('Claude tool use round.', { round, tools: toolUseBlocks.map(b => b.name) });
    }

    const textBlock = response.content && response.content.find(b => b.type === 'text');
    const text = (textBlock && textBlock.text && textBlock.text.trim()) ? textBlock.text.trim() : '';
    if (text) return finish(text);
    logger.warn('Claude hit max tool rounds without final text.', {
      provider: 'claude',
      model: activeModel,
      toolRounds: round,
      durationMs: Date.now() - startedAt,
      outcome: 'empty'
    });
    return finish(formatAIUserMessage({ reason: 'api_error' }));
  } catch (apiError) {
    recordTokenUsage('claude', activeModel, usageTotal);
    rethrowIfBusyForBackup(apiError, 'claude', activeModel);
    captureError(apiError, { provider: 'claude' });
    logger.error('Claude API request failed.', {
      provider: 'claude',
      model: activeModel,
      durationMs: Date.now() - startedAt,
      outcome: 'error',
      ...serializeError(apiError, { includeStack: true })
    });
    return formatAIUserMessage({ error: apiError, provider: 'claude' });
  }
}

/**
 * Generates an AI response using OpenAI's API based on the provided conversation history.
 *
 * @param {Array<{role: string, content: string|Array}>} conversation - Array of conversation messages
 * @returns {Promise<string>} The generated AI response, or empty string if generation fails
 */
async function generateOpenAIResponse(conversation, activeModel = modelName) {
  const startedAt = Date.now();
  if (!openai) {
    logger.error('OpenAI API key not configured (OPENAI_API_KEY).');
    return formatAIUserMessage({ reason: 'missing_api_key', provider: 'openai' });
  }

  try {
    // Keep system and static content first for OpenAI automatic prompt caching (≥1024 tokens; cache-friendly order).
    let messages = [...conversation];
    if (hasImages(conversation)) {
      const sysIdx = messages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0 && typeof messages[sysIdx].content === 'string') {
        messages[sysIdx] = {
          role: 'system',
          content: `${messages[sysIdx].content}\n\n${SYSTEM_MESSAGES.IMAGE_ANALYSIS}`
        };
      } else {
        messages.unshift({
          role: 'system',
          content: SYSTEM_MESSAGES.IMAGE_ANALYSIS
        });
      }
    }

    // OpenAI caches repeated prefixes automatically; prompt_cache_key below improves hit rates.
    // (Anthropic-style cache_control blocks are not part of the Responses API.)
    const normalizedReasoningEffort = resolveOpenAIReasoningEffort(activeModel, reasoningEffort);
    const usesReasoning = normalizedReasoningEffort !== 'none';
    // No temperature: the bot only ever used the default (1.0), and GPT-6 docs say to drop sampling
    // parameters whenever reasoning is on.
    const requestParams = {
      model: activeModel,
      input: messages,
      max_output_tokens: usesReasoning
        ? Math.min(OPENAI_MAX_OUTPUT_TOKENS, maxOutputTokens + OPENAI_REASONING_HEADROOM_TOKENS)
        : maxOutputTokens,
      reasoning: { effort: normalizedReasoningEffort }
    };

    if (enableContextCache) {
      requestParams.prompt_cache_key = OPENAI_PROMPT_CACHE_KEY;
      if (OPENAI_EXTENDED_CACHE_MODELS.has(activeModel)) requestParams.prompt_cache_retention = '24h';
    }

    const normalizedVerbosity = typeof responsesVerbosity === 'string'
      ? responsesVerbosity.trim().toLowerCase()
      : '';

    if (['low', 'medium', 'high'].includes(normalizedVerbosity)) {
      requestParams.text = {
        ...(requestParams.text || {}),
        verbosity: normalizedVerbosity
      };
    }

    if (enableWebSearch) {
      requestParams.tools = [{ type: 'web_search' }];
    }

    logger.debug(`Sending conversation to OpenAI API using model ${activeModel}.`, {
      messageCount: conversation.length,
      model: activeModel,
      reasoningEffort: normalizedReasoningEffort,
      verbosity: normalizedVerbosity || undefined,
      webSearch: enableWebSearch,
      hasImages: hasImages(conversation),
      promptCacheEnabled: enableContextCache
    });

    let response;
    try {
      response = await openai.responses.create(requestParams);
    } catch (apiError) {
      rethrowIfBusyForBackup(apiError, 'openai', activeModel);
      captureError(apiError, { provider: 'openai' });
      logger.error('API request failed.', {
        provider: 'openai',
        model: activeModel,
        durationMs: Date.now() - startedAt,
        outcome: 'error',
        ...serializeError(apiError, { includeStack: true })
      });
      return formatAIUserMessage({ error: apiError, provider: 'openai' });
    }

    recordTokenUsage('openai', activeModel, normalizeOpenAIUsage(response?.usage));

    logger.debug('Received response from OpenAI API.', {
      responseId: response.id,
      status: response.status,
      totalTokens: response.usage?.total_tokens
    });

    const reply = response.output_text || '';

    if (response.status !== 'completed') {
      logger.warn('OpenAI API response was not completed.', {
        provider: 'openai',
        model: activeModel,
        responseStatus: response.status,
        responseId: response.id,
        incompleteDetails: response.incomplete_details || undefined,
        hasOutputText: Boolean(reply && reply.trim()),
        durationMs: Date.now() - startedAt,
        outcome: 'partial'
      });

      if (reply && reply.trim()) return reply;
      return formatAIUserMessage({ reason: 'empty_response' });
    }

    if (!reply || reply.trim() === '') {
      logger.warn('Response is empty.', {
        provider: 'openai',
        model: activeModel,
        responseId: response.id,
        durationMs: Date.now() - startedAt,
        outcome: 'empty'
      });
      return formatAIUserMessage({ reason: 'empty_response' });
    }

    logger.info('Generated AI response successfully.', {
      provider: 'openai',
      model: activeModel,
      responseId: response.id,
      charCount: reply.length,
      tokensUsed: response.usage?.total_tokens,
      inputMessageCount: conversation.length,
      durationMs: Date.now() - startedAt,
      outcome: 'success'
    });

    return reply;
  } catch (error) {
    if (isProviderBusyError(error)) throw error;
    captureError(error, { provider: aiProvider || 'unknown' });
    logger.error('Error occurred while generating AI response.', {
      provider: 'openai',
      model: activeModel,
      durationMs: Date.now() - startedAt,
      outcome: 'error',
      errorType: error?.type ?? 'unknown',
      errorCode: error?.code ?? 'unknown',
      ...serializeError(error, { includeStack: true })
    });
    return formatAIUserMessage({ error, provider: aiProvider || 'openai' });
  }
}

/**
 * Generates an AI response using the configured provider (OpenAI, Gemini, or Claude).
 *
 * @param {Array<{role: string, content: string|Array}>} conversation - Array of conversation messages
 * @returns {Promise<string>} The generated AI response, or a user-facing error message if generation fails
 */
async function generateAIResponse(conversation) {
  if (!conversation || conversation.length === 0) {
    logger.error('Cannot generate AI response; empty conversation provided.');
    recordCount('ai.generate.requests', 1, {
      provider: aiProvider,
      outcome: 'empty_conversation'
    });
    return formatAIUserMessage({ reason: 'api_error' });
  }

  const startedAt = Date.now();

  return startSpan({
    op: 'ai.generate',
    name: `Generate AI response (${aiProvider})`
  }, async () => {
    try {
      const conversationForApi = prepareConversationForApi(conversation);

      const invokeProviderFor = async (provider, activeModel) => {
        if (provider === 'gemini') return generateGeminiResponse(conversationForApi, activeModel);
        if (provider === 'claude') return generateClaudeResponse(conversationForApi, activeModel);
        return generateOpenAIResponse(conversationForApi, activeModel);
      };

      const attempts = [
        { provider: aiProvider, model: modelName, tier: 'primary' },
        ...(backupModels ?? []).map(backup => ({
          provider: backup.provider,
          model: backup.model,
          tier: backup.tier
        }))
      ];

      let reply;
      for (let i = 0; i < attempts.length; i++) {
        const { provider, model, tier } = attempts[i];
        try {
          reply = await invokeProviderFor(provider, model);
          if (i > 0) {
            logger.info('Backup model response completed.', {
              provider: aiProvider,
              backupProvider: provider,
              backupModel: model,
              backupTier: tier,
              durationMs: Date.now() - startedAt,
              outcome: isAIUserErrorMessage(reply) ? 'error_user_message' : 'success'
            });
          }
          break;
        } catch (error) {
          const nextAttempt = attempts[i + 1];
          if (!isProviderBusyError(error) || !nextAttempt) {
            throw error;
          }
          logger.warn('Model busy; retrying with backup model.', {
            provider: aiProvider,
            attemptedProvider: provider,
            attemptedModel: error.attemptedModel || model,
            backupProvider: nextAttempt.provider,
            backupModel: nextAttempt.model,
            backupTier: nextAttempt.tier,
            reason: error.reason,
            inputMessageCount: conversation.length
          });
          recordCount('ai.generate.fallback', 1, {
            provider: aiProvider,
            backupProvider: nextAttempt.provider,
            backupTier: nextAttempt.tier,
            reason: error.reason
          });
        }
      }

      const isErrorReply = isAIUserErrorMessage(reply);
      const outcome = isErrorReply ? 'error_user_message' : 'success';
      logger.info('AI generation completed.', {
        provider: aiProvider,
        model: modelName,
        inputMessageCount: conversation.length,
        durationMs: Date.now() - startedAt,
        outcome
      });
      recordCount('ai.generate.requests', 1, {
        provider: aiProvider,
        outcome
      });
      recordDistribution('ai.generate.duration_ms', Date.now() - startedAt, {
        unit: 'millisecond',
        attributes: {
          provider: aiProvider,
          outcome
        }
      });

      return reply;
    } catch (error) {
      captureError(error, { provider: aiProvider || 'unknown', handler: 'generateAIResponse' });
      recordCount('ai.generate.requests', 1, {
        provider: aiProvider,
        outcome: 'error'
      });
      recordDistribution('ai.generate.duration_ms', Date.now() - startedAt, {
        unit: 'millisecond',
        attributes: {
          provider: aiProvider,
          outcome: 'error'
        }
      });
      throw error;
    }
  });
}



module.exports = {
  generateAIResponse,
  ProviderBusyError
};
