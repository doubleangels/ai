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

test('config exits for unsupported models', () => {
  const result = spawnSync(process.execPath, ['-e', "process.env.AI_PROVIDER='openai'; process.env.OPENAI_MODEL_NAME='bogus-model'; require('./config');"], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported openai model/);
});
