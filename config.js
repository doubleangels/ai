require('dotenv').config();
const { captureError } = require('./instrument');

// OpenAI: Responses API models with text + image support. Reasoning (gpt-5*, o3, o4-mini), verbosity (gpt-5*), web search (built-in tool).
const SUPPORTED_MODELS = [
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
  'gpt-5.3-chat-latest',
  'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
  'gpt-5.2-pro', 'gpt-5-pro',
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'o3', 'o4-mini', 'o3-pro', 'o3-mini'
];
const DEFAULT_MODEL = 'gpt-5.4-nano';

// Gemini: text + image, search grounding, thinking. Excludes TTS/Live-only IDs by default.
const SUPPORTED_GEMINI_MODELS = [
  // Gemini 3.x (ai.google.dev/gemini-api/docs/models)
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image-preview',
  // Gemini 2.5 (still widely used; some have published shutdown windows in 2026)
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-image'
];
const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';

// Claude: vision, extended thinking. Include current primary IDs plus maintained aliases/snapshots.
const SUPPORTED_CLAUDE_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001', 'claude-haiku-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5',
  'claude-opus-4-5-20251101', 'claude-opus-4-5',
  'claude-opus-4-1-20250805'
];
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

const aiProvider = (process.env.AI_PROVIDER || 'openai').trim().toLowerCase();
const resolvedProvider = ['gemini', 'claude'].includes(aiProvider) ? aiProvider : 'openai';

const envOpenaiModel = (process.env.OPENAI_MODEL_NAME || '').trim();
const envGeminiModel = (process.env.GEMINI_MODEL_NAME || '').trim();
const envClaudeModel = (process.env.CLAUDE_MODEL_NAME || '').trim();

let resolvedModel;
let defaultForProvider;

// Use whatever model is set for the selected provider (env or default).
if (resolvedProvider === 'gemini') {
  defaultForProvider = DEFAULT_GEMINI_MODEL;
  resolvedModel = envGeminiModel || envOpenaiModel || defaultForProvider;
} else if (resolvedProvider === 'claude') {
  defaultForProvider = DEFAULT_CLAUDE_MODEL;
  resolvedModel = envClaudeModel || envOpenaiModel || defaultForProvider;
} else {
  resolvedModel = envOpenaiModel || DEFAULT_MODEL;
}

const supportedList = resolvedProvider === 'gemini' ? SUPPORTED_GEMINI_MODELS : resolvedProvider === 'claude' ? SUPPORTED_CLAUDE_MODELS : SUPPORTED_MODELS;
if (!supportedList.includes(resolvedModel)) {
  captureError(new Error(`Unsupported ${resolvedProvider} model "${resolvedModel}".`), {
    source: 'config',
    handler: 'modelValidation',
    provider: resolvedProvider
  });
  console.error(
    `Unsupported ${resolvedProvider} model "${resolvedModel}". Supported: ${supportedList.join(', ')}.`
  );
  process.exit(1);
}

/**
 * Application configuration object.
 * Loads environment variables with fallback values where appropriate.
 * @type {Object}
 */
const parsedHistoryLength = parseInt(process.env.MAX_HISTORY_LENGTH, 10);

/** When non-empty, only these Discord guild (server) IDs may use the bot (messages + slash commands). DMs are ignored. */
const allowedGuildIds = new Set(
  (process.env.ALLOWED_GUILD_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

const config = {
  clientId: process.env.DISCORD_CLIENT_ID,
  allowedGuildIds,
  logLevel: process.env.LOG_LEVEL || 'info',
  maxHistoryLength: (Number.isNaN(parsedHistoryLength) || parsedHistoryLength < 0) ? 20 : parsedHistoryLength,
  // Rough, token-estimated cap for stored history (in addition to maxHistoryLength).
  // If unset/invalid, token trimming is effectively disabled.
  maxHistoryTokens: parseInt(process.env.MAX_HISTORY_TOKENS, 10) || 0,
  modelName: resolvedModel,
  openaiApiKey: process.env.OPENAI_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  aiProvider: resolvedProvider,
  reasoningEffort: process.env.REASONING_EFFORT || 'none',
  responsesVerbosity: process.env.RESPONSES_VERBOSITY || 'low',
  enableWebSearch: process.env.ENABLE_WEB_SEARCH === 'true' || process.env.ENABLE_WEB_SEARCH === '1',
  enableGoogleMaps: process.env.ENABLE_GOOGLE_MAPS === 'true' || process.env.ENABLE_GOOGLE_MAPS === '1',
  // Context / prompt caching (reduces cost and latency for repeated static content). Single switch for all providers.
  enableContextCache: process.env.ENABLE_CONTEXT_CACHE === 'true' || process.env.ENABLE_CONTEXT_CACHE === '1',
  geminiCacheTtlSeconds: Math.max(60, Math.min(86400 * 24, parseInt(process.env.GEMINI_CACHE_TTL_SECONDS, 10) || 3600)),
  // Gemini safety/generation: optional JSON array of { category, threshold } (e.g. [{"category":"HARM_CATEGORY_HARASSMENT","threshold":"BLOCK_MEDIUM_AND_ABOVE"}]). Unset = API defaults.
  geminiSafetySettings: (() => {
    const raw = process.env.GEMINI_SAFETY_SETTINGS;
    if (!raw || typeof raw !== 'string') return undefined;
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length > 0 ? arr : undefined;
    } catch (_) {
      return undefined;
    }
  })(),
  // Max output tokens per response (all providers). Unset, invalid, or 0 => use default 1024; clamped to 256–65536.
  maxOutputTokens: Math.max(256, Math.min(65536, parseInt(process.env.MAX_OUTPUT_TOKENS, 10) || 1024)),
  // Claude extended thinking: token budget for reasoning (0 = disabled). Only used for models that support it (e.g. 4.5).
  claudeThinkingBudgetTokens: Math.max(0, Math.min(32000, parseInt(process.env.CLAUDE_THINKING_BUDGET_TOKENS, 10) || 0)),
  // Basic anti-spam/cost controls (in-memory, per process).
  userCooldownMs: parseInt(process.env.USER_COOLDOWN_MS, 10) || 4000,
  channelCooldownMs: parseInt(process.env.CHANNEL_COOLDOWN_MS, 10) || 1500,
  maxPendingPerChannel: parseInt(process.env.MAX_PENDING_PER_CHANNEL, 10) || 3,
  // Image download safety limits
  imageDownloadTimeoutMs: parseInt(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS, 10) || 8000,
  maxImageBytes: parseInt(process.env.MAX_IMAGE_BYTES, 10) || 6_000_000,
  // OpenAI client: request timeout (ms) and max retries for transient failures.
  openaiTimeoutMs: Math.max(5000, Math.min(300000, parseInt(process.env.OPENAI_TIMEOUT_MS, 10) || 60000)),
  openaiMaxRetries: Math.max(0, Math.min(5, parseInt(process.env.OPENAI_MAX_RETRIES, 10) || 2)),
  token: process.env.DISCORD_BOT_TOKEN,
};

/**
 * Gets the temperature setting for the current model.
 * @returns {number} Temperature value (1.0 for all models)
 */
function getTemperature() {
  return 1.0;
}

module.exports = {
  ...config,
  SUPPORTED_MODELS,
  SUPPORTED_GEMINI_MODELS,
  SUPPORTED_CLAUDE_MODELS,
  getTemperature
};