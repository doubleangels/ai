const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('node:child_process');

const configPath = path.resolve(__dirname, '..', 'config.js');

function loadConfig(overrides) {
  const keys = Object.keys(overrides);
  const saved = new Map(keys.map(key => [key, process.env[key]]));

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  delete require.cache[configPath];
  const loaded = require(configPath);

  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  delete require.cache[configPath];
  return loaded;
}

test('config resolves OpenAI defaults and allowed guilds', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    ALLOWED_GUILD_IDS: 'guild-1, guild-2',
    MAX_HISTORY_LENGTH: '12',
    MAX_HISTORY_TOKENS: '64',
    MAX_OUTPUT_TOKENS: '2048'
  });

  assert.equal(config.aiProvider, 'openai');
  assert.equal(config.modelName, 'gpt-5.4-nano');
  assert.equal(config.allowedGuildIds.size, 2);
  assert.equal(config.maxHistoryLength, 12);
  assert.equal(config.maxHistoryTokens, 64);
  assert.equal(config.maxOutputTokens, 2048);
});

test('config resolves Gemini and parses safety settings', () => {
  const config = loadConfig({
    AI_PROVIDER: 'gemini',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    GEMINI_SAFETY_SETTINGS: '[{"category":"HARM_CATEGORY_HARASSMENT","threshold":"BLOCK_MEDIUM_AND_ABOVE"}]',
    GEMINI_CACHE_TTL_SECONDS: '90',
    ENABLE_CONTEXT_CACHE: '1'
  });

  assert.equal(config.aiProvider, 'gemini');
  assert.equal(config.modelName, 'gemini-3-flash-preview');
  assert.equal(Array.isArray(config.geminiSafetySettings), true);
  assert.equal(config.geminiSafetySettings.length, 1);
  assert.equal(config.geminiCacheTtlSeconds, 90);
  assert.equal(config.enableContextCache, true);
});

test('config resolves Claude and falls back to the open model field', () => {
  const config = loadConfig({
    AI_PROVIDER: 'claude',
    OPENAI_MODEL_NAME: 'claude-sonnet-4-6',
    CLAUDE_THINKING_BUDGET_TOKENS: '1024'
  });

  assert.equal(config.aiProvider, 'claude');
  assert.equal(config.modelName, 'claude-sonnet-4-6');
  assert.equal(config.claudeThinkingBudgetTokens, 1024);
});

test('config resolves gemini model from GEMINI_MODEL_NAME', () => {
  const config = loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: 'gemini-3-flash-preview',
    OPENAI_MODEL_NAME: undefined
  });
  assert.equal(config.modelName, 'gemini-3-flash-preview');
});

test('config resolves gemini model from OPENAI_MODEL_NAME fallback', () => {
  const config = loadConfig({
    AI_PROVIDER: 'gemini',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    GEMINI_MODEL_NAME: undefined
  });
  assert.equal(config.modelName, 'gemini-3-flash-preview');
});

test('config resolves claude model from OPENAI_MODEL_NAME fallback', () => {
  const config = loadConfig({
    AI_PROVIDER: 'claude',
    OPENAI_MODEL_NAME: 'claude-sonnet-4-6',
    CLAUDE_MODEL_NAME: undefined
  });
  assert.equal(config.modelName, 'claude-sonnet-4-6');
});

test('config ignores empty GEMINI_SAFETY_SETTINGS array', () => {
  const config = loadConfig({
    AI_PROVIDER: 'gemini',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    GEMINI_SAFETY_SETTINGS: '[]'
  });
  assert.equal(config.geminiSafetySettings, undefined);
});

test('config ignores invalid GEMINI_SAFETY_SETTINGS JSON', () => {
  const config = loadConfig({
    AI_PROVIDER: 'gemini',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    GEMINI_SAFETY_SETTINGS: '{not-json'
  });

  assert.equal(config.geminiSafetySettings, undefined);
});

test('config resolves model names from each provider-specific env field', () => {
  const geminiPrimary = loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: 'gemini-3-flash-preview',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano'
  });
  assert.equal(geminiPrimary.modelName, 'gemini-3-flash-preview');

  const claudePrimary = loadConfig({
    AI_PROVIDER: 'claude',
    CLAUDE_MODEL_NAME: 'claude-sonnet-4-6',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano'
  });
  assert.equal(claudePrimary.modelName, 'claude-sonnet-4-6');

  const openaiBlank = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: ''
  });
  assert.equal(openaiBlank.modelName, 'gpt-5.4-nano');

  const openaiTrimmed = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: '  gpt-5.4-nano  '
  });
  assert.equal(openaiTrimmed.modelName, 'gpt-5.4-nano');
});

test('config exits for unsupported models', () => {
  const result = spawnSync(process.execPath, ['-e', "process.env.AI_PROVIDER='openai'; process.env.OPENAI_MODEL_NAME='bogus-model'; require('./config');"], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported openai model/);
});

test('config uses provider defaults when model env vars are unset', () => {
  const geminiDefault = loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: undefined,
    OPENAI_MODEL_NAME: undefined
  });
  assert.equal(geminiDefault.modelName, 'gemini-3-flash-preview');

  const claudeDefault = loadConfig({
    AI_PROVIDER: 'claude',
    CLAUDE_MODEL_NAME: undefined,
    OPENAI_MODEL_NAME: undefined
  });
  assert.equal(claudeDefault.modelName, 'claude-sonnet-4-6');
});

test('config falls back to defaults when model env vars are whitespace only', () => {
  const geminiWs = loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: '   ',
    OPENAI_MODEL_NAME: undefined
  });
  assert.equal(geminiWs.modelName, 'gemini-3-flash-preview');

  const claudeWs = loadConfig({
    AI_PROVIDER: 'claude',
    CLAUDE_MODEL_NAME: '   ',
    OPENAI_MODEL_NAME: undefined
  });
  assert.equal(claudeWs.modelName, 'claude-sonnet-4-6');

  const openaiWs = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: '   '
  });
  assert.equal(openaiWs.modelName, 'gpt-5.4-nano');
});
