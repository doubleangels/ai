require('dotenv').config();
const { captureError } = require('./instrument');

// OpenAI: Responses API models with text + image support. Reasoning (gpt-5*, o3, o4-mini), verbosity (gpt-5*), web search (built-in tool).
const SUPPORTED_MODELS = [
  'gpt-5.5', 'gpt-5.5-pro',
  'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
  'gpt-5.3-chat-latest', 'gpt-5.3-codex',
  'gpt-5.2', 'gpt-5.2-pro', 'gpt-5.2-codex', 'gpt-5.2-chat-latest',
  'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1-codex-max', 'gpt-5.1-chat-latest',
  'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro',
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'gpt-4o', 'gpt-4o-mini',
  'o3', 'o4-mini', 'o3-pro', 'o3-mini'
];
const DEFAULT_MODEL = 'gpt-5.4-nano';

// Gemini: text + image, search grounding, thinking. Excludes TTS/Live-only IDs by default.
const SUPPORTED_GEMINI_MODELS = [
  // Gemini 3.x (ai.google.dev/gemini-api/docs/models)
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-image',
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
  'claude-opus-4-1-20250805', 'claude-opus-4-1',
  'claude-sonnet-4-20250514', 'claude-sonnet-4-0',
  'claude-opus-4-20250514', 'claude-opus-4-0'
];
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';

/** Gemini models that support generateContent with IMAGE modality (/imagine). */
const SUPPORTED_GEMINI_IMAGE_MODELS = [
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-image',
  'gemini-2.5-flash-image'
];

/** Aspect ratios supported by Gemini Image models. */
const IMAGE_ASPECT_RATIOS = {
  '1:1': '1:1',
  '16:9': '16:9',
  '9:16': '9:16',
  '4:3': '4:3',
  '3:4': '3:4'
};

/**
 * @param {string} envName
 * @returns {string}
 */
function resolveGeminiImagePrimaryModel(envName = 'GEMINI_IMAGE_MODEL_NAME') {
  const primary = (process.env.GEMINI_IMAGE_MODEL_NAME || '').trim();
  if (primary) {
    if (primary.startsWith('imagen-')) {
      console.warn(
        `${envName} "${primary}" is an Imagen model; using ${DEFAULT_GEMINI_IMAGE_MODEL} instead.`
      );
      return DEFAULT_GEMINI_IMAGE_MODEL;
    }
    return primary;
  }

  return DEFAULT_GEMINI_IMAGE_MODEL;
}

/**
 * @param {string} primaryModel
 * @returns {string|null}
 */
function resolveGeminiImageBackupModel(primaryModel) {
  const backup = (process.env.SECONDARY_GEMINI_IMAGE_MODEL_NAME || '').trim();
  if (!backup) return null;

  if (backup.startsWith('imagen-')) {
    console.warn(`SECONDARY_GEMINI_IMAGE_MODEL_NAME "${backup}" is an Imagen model; entry disabled.`);
    return null;
  }
  if (!SUPPORTED_GEMINI_IMAGE_MODELS.includes(backup)) {
    console.warn(
      `SECONDARY_GEMINI_IMAGE_MODEL_NAME "${backup}" is not a supported Gemini Image model; entry disabled.`
    );
    return null;
  }
  if (backup === primaryModel) {
    console.warn('SECONDARY_GEMINI_IMAGE_MODEL_NAME matches the primary image model; entry disabled.');
    return null;
  }

  return backup;
}

const resolvedGeminiImagePrimaryModel = resolveGeminiImagePrimaryModel();
const resolvedGeminiImageBackupModel = resolveGeminiImageBackupModel(resolvedGeminiImagePrimaryModel);

const SUPPORTED_AI_PROVIDERS = ['openai', 'gemini', 'claude'];
const PROVIDER_MODEL_LISTS = {
  openai: SUPPORTED_MODELS,
  gemini: SUPPORTED_GEMINI_MODELS,
  claude: SUPPORTED_CLAUDE_MODELS
};

/**
 * @param {string} modelName
 * @returns {'openai'|'gemini'|'claude'|null}
 */
function resolveProviderForModel(modelName) {
  const matches = SUPPORTED_AI_PROVIDERS.filter(provider => PROVIDER_MODEL_LISTS[provider].includes(modelName));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * @param {string} provider
 * @returns {string|undefined}
 */
function apiKeyForProvider(provider) {
  if (provider === 'gemini') return process.env.GEMINI_API_KEY;
  if (provider === 'claude') return process.env.ANTHROPIC_API_KEY;
  return process.env.OPENAI_API_KEY;
}

/**
 * @param {string} envModel
 * @param {string} envProvider
 * @param {string} modelEnvName
 * @param {string} providerEnvName
 * @param {Set<string>} reservedKeys
 * @param {string} primaryModel
 * @param {string} primaryProvider
 * @returns {{ model: string, provider: 'openai'|'gemini'|'claude' } | null}
 */
function resolveBackupModelEntry(envModel, envProvider, modelEnvName, providerEnvName, reservedKeys, primaryModel, primaryProvider) {
  if (!envModel) return null;

  let resolvedFallbackProvider = null;
  if (envProvider) {
    if (!SUPPORTED_AI_PROVIDERS.includes(envProvider)) {
      console.warn(
        `${providerEnvName} "${envProvider}" is invalid; supported values are ${SUPPORTED_AI_PROVIDERS.join(', ')}. Entry disabled.`
      );
    } else if (!PROVIDER_MODEL_LISTS[envProvider].includes(envModel)) {
      console.warn(
        `${modelEnvName} "${envModel}" is not supported for ${providerEnvName} "${envProvider}"; entry disabled.`
      );
    } else {
      resolvedFallbackProvider = envProvider;
    }
  } else {
    resolvedFallbackProvider = resolveProviderForModel(envModel);
    if (!resolvedFallbackProvider) {
      console.warn(`${modelEnvName} "${envModel}" is not a supported model; entry disabled.`);
    }
  }

  if (!resolvedFallbackProvider) return null;

  const key = `${resolvedFallbackProvider}:${envModel}`;
  if (envModel === primaryModel && resolvedFallbackProvider === primaryProvider) {
    console.warn(`${modelEnvName} matches the primary model; entry disabled.`);
    return null;
  }
  if (reservedKeys.has(key)) {
    console.warn(`${modelEnvName} duplicates an earlier model/provider pair; entry disabled.`);
    return null;
  }

  if (!apiKeyForProvider(resolvedFallbackProvider)) {
    console.warn(
      `Backup provider "${resolvedFallbackProvider}" requires an API key but none is configured; entry disabled.`
    );
    return null;
  }

  reservedKeys.add(key);
  return { model: envModel, provider: resolvedFallbackProvider };
}

const aiProvider = (process.env.AI_PROVIDER || 'openai').trim().toLowerCase();
if (!SUPPORTED_AI_PROVIDERS.includes(aiProvider)) {
  console.error(`Invalid AI_PROVIDER "${process.env.AI_PROVIDER}". Supported values are ${SUPPORTED_AI_PROVIDERS.join(', ')}.`);
  process.exit(1);
}
const resolvedProvider = aiProvider;

/**
 * Parses an integer env var; preserves 0. Returns default when unset or invalid.
 * @param {string|undefined} value
 * @param {number} defaultValue
 * @returns {number}
 */
function parseEnvInt(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const parsed = parseInt(String(value), 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

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
  console.error(`Unsupported ${resolvedProvider} model "${resolvedModel}". Supported models are ${supportedList.join(', ')}.`);
  process.exit(1);
}

/**
 * Application configuration object.
 * Loads environment variables with fallback values where appropriate.
 * @type {Object}
 */
const parsedHistoryLength = parseInt(process.env.MAX_HISTORY_LENGTH, 10);

const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

/** When non-empty, only listed guild IDs may use the bot; DMs are blocked. When empty, all guilds and DMs are allowed. */
const allowedGuildIdList = (process.env.ALLOWED_GUILD_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

for (const guildId of allowedGuildIdList) {
  if (!DISCORD_SNOWFLAKE_RE.test(guildId)) {
    console.warn(
      `ALLOWED_GUILD_IDS contains invalid guild ID "${guildId}" (expected a numeric Discord snowflake). Messages from that ID will never match.`
    );
  }
}

const allowedGuildIds = new Set(allowedGuildIdList);

const reservedBackupKeys = new Set();
const backupModels = [];
const backupModelSlots = [
  {
    model: (process.env.SECONDARY_MODEL_NAME || '').trim(),
    provider: (process.env.SECONDARY_AI_PROVIDER || '').trim().toLowerCase(),
    modelEnvName: 'SECONDARY_MODEL_NAME',
    providerEnvName: 'SECONDARY_AI_PROVIDER',
    tier: 'secondary'
  },
  {
    model: (process.env.TERTIARY_MODEL_NAME || '').trim(),
    provider: (process.env.TERTIARY_AI_PROVIDER || '').trim().toLowerCase(),
    modelEnvName: 'TERTIARY_MODEL_NAME',
    providerEnvName: 'TERTIARY_AI_PROVIDER',
    tier: 'tertiary'
  }
];
for (const slot of backupModelSlots) {
  const entry = resolveBackupModelEntry(
    slot.model,
    slot.provider,
    slot.modelEnvName,
    slot.providerEnvName,
    reservedBackupKeys,
    resolvedModel,
    resolvedProvider
  );
  if (entry) backupModels.push({ ...entry, tier: slot.tier });
}
const secondaryModelName = backupModels.find(entry => entry.tier === 'secondary')?.model ?? null;
const secondaryProvider = backupModels.find(entry => entry.tier === 'secondary')?.provider ?? null;
const tertiaryModelName = backupModels.find(entry => entry.tier === 'tertiary')?.model ?? null;
const tertiaryProvider = backupModels.find(entry => entry.tier === 'tertiary')?.provider ?? null;

const shardCountRaw = (process.env.DISCORD_SHARD_COUNT || '').trim().toLowerCase();
let discordShardCount = 0;
if (shardCountRaw === 'auto') {
  discordShardCount = 'auto';
} else if (shardCountRaw) {
  const parsedShards = parseInt(shardCountRaw, 10);
  discordShardCount = Number.isNaN(parsedShards) || parsedShards < 1 ? 0 : parsedShards;
}

const config = {
  clientId: process.env.DISCORD_CLIENT_ID,
  allowedGuildIds,
  logLevel: process.env.LOG_LEVEL || 'info',
  maxHistoryLength: (() => {
    if (Number.isNaN(parsedHistoryLength) || parsedHistoryLength < 0) return 10;
    return Math.max(1, parsedHistoryLength);
  })(),
  // Rough, token-estimated cap for stored history (in addition to maxHistoryLength).
  // If unset/invalid, token trimming is effectively disabled.
  maxHistoryTokens: parseEnvInt(process.env.MAX_HISTORY_TOKENS, 0),
  modelName: resolvedModel,
  backupModels,
  secondaryModelName,
  secondaryProvider,
  tertiaryModelName,
  tertiaryProvider,
  discordShardCount,
  openaiApiKey: process.env.OPENAI_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  aiProvider: resolvedProvider,
  reasoningEffort: process.env.REASONING_EFFORT || 'none',
  responsesVerbosity: process.env.RESPONSES_VERBOSITY || 'low',
  enableWebSearch: process.env.ENABLE_WEB_SEARCH === 'true' || process.env.ENABLE_WEB_SEARCH === '1',
  enableGoogleMaps: process.env.ENABLE_GOOGLE_MAPS === 'true' || process.env.ENABLE_GOOGLE_MAPS === '1',
  // Context / prompt caching (reduces cost and latency for repeated static content). Single switch for all providers.
  enableContextCache: (() => {
    const raw = (process.env.ENABLE_CONTEXT_CACHE ?? 'true').trim().toLowerCase();
    return raw !== 'false' && raw !== '0';
  })(),
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
  userCooldownMs: parseEnvInt(process.env.USER_COOLDOWN_MS, 4000),
  channelCooldownMs: parseEnvInt(process.env.CHANNEL_COOLDOWN_MS, 1500),
  maxPendingPerChannel: parseEnvInt(process.env.MAX_PENDING_PER_CHANNEL, 3),
  // Reply chain traversal cap (Discord parent-message fetches before AI call).
  maxReplyChainDepth: Math.max(1, Math.min(50, parseInt(process.env.MAX_REPLY_CHAIN_DEPTH, 10) || 15)),
  // In-memory Discord message cache for reply-chain traversal (LRU + TTL).
  messageCacheMaxSize: Math.max(10, Math.min(10000, parseInt(process.env.MESSAGE_CACHE_MAX_SIZE, 10) || 500)),
  messageCacheTtlMs: Math.max(60_000, Math.min(86_400_000, parseInt(process.env.MESSAGE_CACHE_TTL_MS, 10) || 1_800_000)),
  // Image download safety limits
  imageDownloadTimeoutMs: parseInt(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS, 10) || 8000,
  maxImageBytes: parseInt(process.env.MAX_IMAGE_BYTES, 10) || 6_000_000,
  // Max images (attachments + embed previews) collected from a reply chain per request.
  maxReplyChainImages: Math.max(1, Math.min(10, parseInt(process.env.MAX_REPLY_CHAIN_IMAGES, 10) || 4)),
  // OpenAI client: request timeout (ms) and max retries for transient failures.
  openaiTimeoutMs: Math.max(5000, Math.min(300000, parseEnvInt(process.env.OPENAI_TIMEOUT_MS, 60000))),
  openaiMaxRetries: Math.max(0, Math.min(5, parseEnvInt(process.env.OPENAI_MAX_RETRIES, 2))),
  geminiTimeoutMs: Math.max(5000, Math.min(300000, parseEnvInt(process.env.GEMINI_TIMEOUT_MS, 60000))),
  claudeTimeoutMs: Math.max(5000, Math.min(300000, parseEnvInt(process.env.CLAUDE_TIMEOUT_MS, 60000))),
  // Gemini Image generation (/imagine command). Uses GEMINI_API_KEY.
  geminiImageModel: resolvedGeminiImagePrimaryModel,
  geminiImageBackupModel: resolvedGeminiImageBackupModel,
  imageGenerationTimeoutMs: Math.max(10_000, Math.min(300_000, parseEnvInt(process.env.IMAGE_GENERATION_TIMEOUT_MS, 120_000))),
  imageUserCooldownMs: parseEnvInt(process.env.IMAGE_USER_COOLDOWN_MS, 30_000),
  // In-memory conversation store bounds (per process).
  conversationHistoryMaxChannels: Math.max(0, Math.min(10000, parseInt(process.env.CONVERSATION_HISTORY_MAX_CHANNELS, 10) || 500)),
  conversationHistoryIdleMs: Math.max(0, Math.min(86_400_000 * 7, parseInt(process.env.CONVERSATION_HISTORY_IDLE_MS, 10) || 86_400_000)),
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
  SUPPORTED_GEMINI_IMAGE_MODELS,
  SUPPORTED_CLAUDE_MODELS,
  IMAGE_ASPECT_RATIOS,
  DEFAULT_GEMINI_IMAGE_MODEL,
  getTemperature
};