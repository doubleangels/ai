require('dotenv').config();

// OpenAI: Responses API models with text + image support. Reasoning (gpt-5*, o3, o4-mini), verbosity (gpt-5*), web search (built-in tool).
const SUPPORTED_MODELS = [
  'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
  'gpt-5.2-pro', 'gpt-5-pro',
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'o3', 'o4-mini', 'o3-pro', 'o3-mini'
];
const DEFAULT_MODEL = 'gpt-5-nano';

// Gemini: text + image, search grounding, thinking. Excludes image-gen-only, TTS, Live.
const SUPPORTED_GEMINI_MODELS = [
  'gemini-3-pro-preview', 'gemini-3-flash-preview',
  'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite'
];
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

// Claude: vision, extended thinking (4.5). Aliases and versioned IDs.
const SUPPORTED_CLAUDE_MODELS = [
  'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5',
  'claude-haiku-4-5-20251001', 'claude-haiku-4-5',
  'claude-opus-4-5-20251101', 'claude-opus-4-5',
  'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307',
  'claude-sonnet-4-20250514', 'claude-3-5-sonnet-20240620'
];
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const aiProvider = (process.env.AI_PROVIDER || 'openai').trim().toLowerCase();
const resolvedProvider = ['gemini', 'claude'].includes(aiProvider) ? aiProvider : 'openai';

const envModel = (process.env.MODEL_NAME || '').trim();
const envGeminiModel = (process.env.GEMINI_MODEL_NAME || '').trim();
const envClaudeModel = (process.env.CLAUDE_MODEL_NAME || '').trim();

let resolvedModel = DEFAULT_MODEL;
let modelList = SUPPORTED_MODELS;
let defaultForProvider = DEFAULT_MODEL;

if (resolvedProvider === 'gemini') {
  modelList = SUPPORTED_GEMINI_MODELS;
  defaultForProvider = DEFAULT_GEMINI_MODEL;
  const candidate = envGeminiModel || envModel || defaultForProvider;
  resolvedModel = modelList.includes(candidate) ? candidate : defaultForProvider;
  if (candidate && !modelList.includes(candidate)) {
    console.warn(
      `Unsupported Gemini model "${candidate}". Falling back to "${resolvedModel}". ` +
      `Supported: ${modelList.join(', ')}.`
    );
  }
} else if (resolvedProvider === 'claude') {
  modelList = SUPPORTED_CLAUDE_MODELS;
  defaultForProvider = DEFAULT_CLAUDE_MODEL;
  const candidate = envClaudeModel || envModel || defaultForProvider;
  resolvedModel = modelList.includes(candidate) ? candidate : defaultForProvider;
  if (candidate && !modelList.includes(candidate)) {
    console.warn(
      `Unsupported Claude model "${candidate}". Falling back to "${resolvedModel}". ` +
      `Supported: ${modelList.join(', ')}.`
    );
  }
} else {
  if (!envModel) {
    resolvedModel = DEFAULT_MODEL;
  } else if (SUPPORTED_MODELS.includes(envModel)) {
    resolvedModel = envModel;
  } else {
    console.warn(
      `Unsupported MODEL_NAME "${envModel}" provided. Falling back to default "${DEFAULT_MODEL}". ` +
      `Supported models: ${SUPPORTED_MODELS.join(', ')}.`
    );
    resolvedModel = DEFAULT_MODEL;
  }
}

/**
 * Application configuration object.
 * Loads environment variables with fallback values where appropriate.
 * @type {Object}
 */
const config = {
  clientId: process.env.DISCORD_CLIENT_ID,
  logLevel: process.env.LOG_LEVEL || 'info',
  maxHistoryLength: parseInt(process.env.MAX_HISTORY_LENGTH, 10) || 20,
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
  // Basic anti-spam/cost controls (in-memory, per process).
  userCooldownMs: parseInt(process.env.USER_COOLDOWN_MS, 10) || 4000,
  channelCooldownMs: parseInt(process.env.CHANNEL_COOLDOWN_MS, 10) || 1500,
  maxPendingPerChannel: parseInt(process.env.MAX_PENDING_PER_CHANNEL, 10) || 3,
  // Image download safety limits
  imageDownloadTimeoutMs: parseInt(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS, 10) || 8000,
  maxImageBytes: parseInt(process.env.MAX_IMAGE_BYTES, 10) || 6_000_000,
  token: process.env.DISCORD_BOT_TOKEN,
};

/**
 * Gets the temperature setting for the current model.
 * @returns {number} Temperature value (0.7 for most models, 1.0 for GPT-5 models)
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