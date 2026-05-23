const path = require('path');
const { spawnSync } = require('node:child_process');
const { stubModule, reloadModule } = require('./testUtils.cjs');

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

  const loaded = reloadModule(configPath);

  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return loaded;
}

test('should resolves OpenAI defaults and allowed guilds', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    ALLOWED_GUILD_IDS: 'guild-1, guild-2',
    MAX_HISTORY_LENGTH: '12',
    MAX_HISTORY_TOKENS: '64',
    MAX_OUTPUT_TOKENS: '2048'
  });

  expect(config.aiProvider).toBe('openai');
  expect(config.modelName).toBe('gpt-5.4-nano');
  expect(config.allowedGuildIds.size).toBe(2);
  expect(config.maxHistoryLength).toBe(12);
  expect(config.maxHistoryTokens).toBe(64);
  expect(config.maxOutputTokens).toBe(2048);
});

test('should resolves Gemini and parses safety settings', () => {
  const config = loadConfig({
    AI_PROVIDER: 'gemini',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    GEMINI_SAFETY_SETTINGS: '[{"category":"HARM_CATEGORY_HARASSMENT","threshold":"BLOCK_MEDIUM_AND_ABOVE"}]',
    GEMINI_CACHE_TTL_SECONDS: '90',
    ENABLE_CONTEXT_CACHE: '1'
  });

  expect(config.aiProvider).toBe('gemini');
  expect(config.modelName).toBe('gemini-3-flash-preview');
  expect(Array.isArray(config.geminiSafetySettings)).toBe(true);
  expect(config.geminiSafetySettings.length).toBe(1);
  expect(config.geminiCacheTtlSeconds).toBe(90);
  expect(config.enableContextCache).toBe(true);
});

test('should resolves Claude and falls back to the open model field', () => {
  const config = loadConfig({
    AI_PROVIDER: 'claude',
    OPENAI_MODEL_NAME: 'claude-sonnet-4-6',
    CLAUDE_THINKING_BUDGET_TOKENS: '1024'
  });

  expect(config.aiProvider).toBe('claude');
  expect(config.modelName).toBe('claude-sonnet-4-6');
  expect(config.claudeThinkingBudgetTokens).toBe(1024);
});

test('should resolves gemini model from GEMINI_MODEL_NAME', () => {
  const config = loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: 'gemini-3-flash-preview',
    OPENAI_MODEL_NAME: undefined
  });
  expect(config.modelName).toBe('gemini-3-flash-preview');
});

test('should resolves gemini model from OPENAI_MODEL_NAME fallback', () => {
  const config = loadConfig({
    AI_PROVIDER: 'gemini',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    GEMINI_MODEL_NAME: undefined
  });
  expect(config.modelName).toBe('gemini-3-flash-preview');
});

test('should resolves claude model from OPENAI_MODEL_NAME fallback', () => {
  const config = loadConfig({
    AI_PROVIDER: 'claude',
    OPENAI_MODEL_NAME: 'claude-sonnet-4-6',
    CLAUDE_MODEL_NAME: undefined
  });
  expect(config.modelName).toBe('claude-sonnet-4-6');
});

test('should ignores empty GEMINI_SAFETY_SETTINGS array', () => {
  const config = loadConfig({
    AI_PROVIDER: 'gemini',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    GEMINI_SAFETY_SETTINGS: '[]'
  });
  expect(config.geminiSafetySettings).toBe(undefined);
});

test('should ignores invalid GEMINI_SAFETY_SETTINGS JSON', () => {
  const config = loadConfig({
    AI_PROVIDER: 'gemini',
    OPENAI_MODEL_NAME: 'gemini-3-flash-preview',
    GEMINI_SAFETY_SETTINGS: '{not-json'
  });

  expect(config.geminiSafetySettings).toBe(undefined);
});

test('should resolves performance tuning env vars with clamping', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    MAX_REPLY_CHAIN_DEPTH: '99',
    MESSAGE_CACHE_MAX_SIZE: '99999',
    MESSAGE_CACHE_TTL_MS: '999999999'
  });

  expect(config.maxReplyChainDepth).toBe(50);
  expect(config.messageCacheMaxSize).toBe(10000);
  expect(config.messageCacheTtlMs).toBe(86400000);
});

test('should resolves model names from each provider-specific env field', () => {
  const geminiPrimary = loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: 'gemini-3-flash-preview',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano'
  });
  expect(geminiPrimary.modelName).toBe('gemini-3-flash-preview');

  const claudePrimary = loadConfig({
    AI_PROVIDER: 'claude',
    CLAUDE_MODEL_NAME: 'claude-sonnet-4-6',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano'
  });
  expect(claudePrimary.modelName).toBe('claude-sonnet-4-6');

  const openaiBlank = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: ''
  });
  expect(openaiBlank.modelName).toBe('gpt-5.4-nano');

  const openaiTrimmed = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: '  gpt-5.4-nano  '
  });
  expect(openaiTrimmed.modelName).toBe('gpt-5.4-nano');
});

test('should accepts current Gemini GA models', () => {
  for (const model of ['gemini-3.1-flash-lite', 'gemini-3.5-flash']) {
    const config = loadConfig({
      AI_PROVIDER: 'gemini',
      GEMINI_MODEL_NAME: model,
      OPENAI_MODEL_NAME: undefined
    });
    expect(config.modelName).toBe(model);
  }
});

test('should exits for unsupported models', () => {
  const result = spawnSync(process.execPath, ['-e', "process.env.AI_PROVIDER='openai'; process.env.OPENAI_MODEL_NAME='bogus-model'; require('./config');"], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Unsupported openai model/);
});

test('should reports unsupported models in-process before exit', () => {
  const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
  const captureErrors = [];
  const exitCodes = [];
  const originalExit = process.exit;
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  process.exit = code => {
    exitCodes.push(code);
    throw new Error('process.exit');
  };

  try {
    reloadModule(configPath, () => {
      stubModule(instrumentPath, {
        captureError: err => captureErrors.push(err)
      });
      process.env.AI_PROVIDER = 'openai';
      process.env.OPENAI_MODEL_NAME = 'bogus-model';
    });
  } catch (error) {
    expect(error.message).toBe('process.exit');
  } finally {
    process.exit = originalExit;
    errorSpy.mockRestore();
    delete process.env.AI_PROVIDER;
    delete process.env.OPENAI_MODEL_NAME;
  }

  expect(exitCodes).toEqual([1]);
  expect(captureErrors.length).toBe(1);
  expect(String(captureErrors[0].message)).toMatch(/Unsupported openai model/);
});

test('should uses provider defaults when model env vars are unset', () => {
  const geminiDefault = loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: undefined,
    OPENAI_MODEL_NAME: undefined
  });
  expect(geminiDefault.modelName).toBe('gemini-3-flash-preview');

  const claudeDefault = loadConfig({
    AI_PROVIDER: 'claude',
    CLAUDE_MODEL_NAME: undefined,
    OPENAI_MODEL_NAME: undefined
  });
  expect(claudeDefault.modelName).toBe('claude-sonnet-4-6');
});

test('should falls back to defaults when model env vars are whitespace only', () => {
  const geminiWs = loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: '   ',
    OPENAI_MODEL_NAME: undefined
  });
  expect(geminiWs.modelName).toBe('gemini-3-flash-preview');

  const claudeWs = loadConfig({
    AI_PROVIDER: 'claude',
    CLAUDE_MODEL_NAME: '   ',
    OPENAI_MODEL_NAME: undefined
  });
  expect(claudeWs.modelName).toBe('claude-sonnet-4-6');

  const openaiWs = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: '   '
  });
  expect(openaiWs.modelName).toBe('gpt-5.4-nano');
});
