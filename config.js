require('dotenv').config({ quiet: true });
const { captureError } = require('./instrument');

// Model lists contain only CURRENT models (not deprecated, not shut down) per each provider's
// model and deprecation pages as of 2026-11-12. Revisit when providers announce deprecations.

// OpenAI: Responses API models with text + image input (developers.openai.com/api/docs/models).
const SUPPORTED_MODELS = [
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-6.1-sol', 'gpt-6.1-terra',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.5-pro',
  'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini',
  'gpt-5.2', 'gpt-5.2-pro'
];
// gpt-6-luna is OpenAI's high-volume efficiency model (replacement for the deprecated gpt-5.4-nano).
const DEFAULT_MODEL = 'gpt-6-luna';

// Gemini: text + image chat models for generateContent (aistudio.google.com/docs/models).
// Excludes TTS, Live, embedding and image-generation models.
const SUPPORTED_GEMINI_MODELS = [
  'gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite'
];
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

// Claude: current models (platform.claude.com models overview). Legacy, deprecated and retired
// models (Opus 4.5, Sonnet 4.5, Opus 4.1, Opus 4, Sonnet 4) are excluded.
const SUPPORTED_CLAUDE_MODELS = [
  'claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5',
  'claude-opus-5-5', 'claude-opus-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-5-5', 'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-5-5',
  'claude-haiku-4-5', 'claude-haiku-4-5-20251001'
];
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';

/** Output effort levels accepted by Claude's output_config.effort. */
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';

/** Current Gemini models that support generateContent with IMAGE output (/imagine). */
const SUPPORTED_GEMINI_IMAGE_MODELS = [
  'gemini-nano-banana-2.1',
  'gemini-3-pro-image',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image'
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
    if (!SUPPORTED_GEMINI_IMAGE_MODELS.includes(primary)) {
      console.warn(
        `${envName} "${primary}" is not a supported Gemini Image model; using ${DEFAULT_GEMINI_IMAGE_MODEL} instead.`
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

/**
 * When non-empty, only listed guild IDs may use the bot in a guild. When empty, all guilds are allowed.
 * Does not affect DM/user-install slash-command usage (see bot.js#interactionAllowedInGuild), which has no
 * guild to check against; plain-message (mention/reply) chat in events/messageCreate.js still ignores DMs.
 */
/**
 * Parses a comma-separated list of Discord IDs, warning about entries that are not snowflakes.
 * @param {string} envName
 * @param {string} kind - 'guild' or 'user', used in the warning
 * @returns {Set<string>}
 */
function parseSnowflakeList(envName, kind) {
  const ids = (process.env[envName] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  for (const id of ids) {
    if (!DISCORD_SNOWFLAKE_RE.test(id)) {
      console.warn(
        `${envName} contains invalid ${kind} ID "${id}" (expected a numeric Discord snowflake). Messages from that ID will never match.`
      );
    }
  }

  return new Set(ids);
}

const allowedGuildIds = parseSnowflakeList('ALLOWED_GUILD_IDS', 'guild');

/**
 * When non-empty, only listed user IDs may use the bot through user installs (DMs, group DMs,
 * servers the bot isn't in). Members of servers the bot is installed in are governed by
 * ALLOWED_GUILD_IDS instead. When empty, all users are allowed.
 */
const allowedUserIds = parseSnowflakeList('ALLOWED_USER_IDS', 'user');

const claudeEffortRaw = (process.env.CLAUDE_REASONING_EFFORT || '').trim().toLowerCase();
if (claudeEffortRaw && !CLAUDE_EFFORT_LEVELS.includes(claudeEffortRaw)) {
  console.warn(`CLAUDE_REASONING_EFFORT "${process.env.CLAUDE_REASONING_EFFORT}" is invalid; supported values are ${CLAUDE_EFFORT_LEVELS.join(', ')}. Ignoring.`);
}

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
  allowedUserIds,
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
  // Claude thinking (0 = off). Claude 4.5 models use this as budget_tokens; 4.6+ models use adaptive
  // thinking (any value > 0 turns it on) and ignore the number. Claude 5 models always think; use CLAUDE_REASONING_EFFORT.
  claudeThinkingBudgetTokens: Math.max(0, Math.min(32000, parseInt(process.env.CLAUDE_THINKING_BUDGET_TOKENS, 10) || 0)),
  // Claude output_config.effort (low|medium|high|xhigh|max). Unset: low for Claude 5 / Fable models, model default otherwise.
  claudeEffort: CLAUDE_EFFORT_LEVELS.includes(claudeEffortRaw) ? claudeEffortRaw : null,
  // Only mark Claude prompts for caching once the estimated prefix is this large (cache writes cost 1.25x input).
  claudeCacheMinTokens: Math.max(1024, Math.min(200_000, parseEnvInt(process.env.CLAUDE_CACHE_MIN_TOKENS, 2048))),
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
  // Long-side pixel cap for images sent to vision models (resized by Discord's media proxy). 0 disables.
  maxImageDimension: (() => {
    const value = parseEnvInt(process.env.MAX_IMAGE_DIMENSION, 1024);
    return value <= 0 ? 0 : Math.max(256, Math.min(4096, value));
  })(),
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


module.exports = {
  ...config,
  SUPPORTED_MODELS,
  SUPPORTED_GEMINI_MODELS,
  SUPPORTED_GEMINI_IMAGE_MODELS,
  SUPPORTED_CLAUDE_MODELS,
  CLAUDE_EFFORT_LEVELS,
  IMAGE_ASPECT_RATIOS,
  DEFAULT_GEMINI_IMAGE_MODEL
};
