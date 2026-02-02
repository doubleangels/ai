require('dotenv').config();

const SUPPORTED_MODELS = ['gpt-5', 'gpt-5-nano', 'gpt-5-mini'];
const DEFAULT_MODEL = 'gpt-5-nano';

const SUPPORTED_GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash', 'gemini-1.5-pro'];
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const aiProvider = (process.env.AI_PROVIDER || 'openai').trim().toLowerCase();
const resolvedProvider = aiProvider === 'gemini' ? 'gemini' : 'openai';

const envModel = (process.env.MODEL_NAME || '').trim();
const envGeminiModel = (process.env.GEMINI_MODEL_NAME || '').trim();

let resolvedModel = DEFAULT_MODEL;
const modelList = resolvedProvider === 'gemini' ? SUPPORTED_GEMINI_MODELS : SUPPORTED_MODELS;
const defaultForProvider = resolvedProvider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_MODEL;

if (resolvedProvider === 'gemini') {
  const candidate = envGeminiModel || envModel || defaultForProvider;
  resolvedModel = modelList.includes(candidate) ? candidate : defaultForProvider;
  if (candidate && !modelList.includes(candidate)) {
    console.warn(
      `Unsupported Gemini model "${candidate}". Falling back to "${resolvedModel}". ` +
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
  aiProvider: resolvedProvider,
  reasoningEffort: process.env.REASONING_EFFORT || 'minimal',
  responsesVerbosity: process.env.RESPONSES_VERBOSITY || 'low',
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
  getTemperature
};