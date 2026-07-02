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

test('should clamps MAX_HISTORY_LENGTH to at least 1', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    MAX_HISTORY_LENGTH: '0'
  });
  expect(config.maxHistoryLength).toBe(1);
});

test('should resolves conversation history memory bounds from env', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    CONVERSATION_HISTORY_MAX_CHANNELS: '99999',
    CONVERSATION_HISTORY_IDLE_MS: '999999999'
  });
  expect(config.conversationHistoryMaxChannels).toBe(10000);
  expect(config.conversationHistoryIdleMs).toBe(604800000);
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

test('should falls back when integer env values are invalid', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    USER_COOLDOWN_MS: 'not-a-number'
  });
  expect(config.userCooldownMs).toBe(4000);
});

test('should allows zero cooldown env values', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    USER_COOLDOWN_MS: '0',
    CHANNEL_COOLDOWN_MS: '0',
    MAX_PENDING_PER_CHANNEL: '0'
  });
  expect(config.userCooldownMs).toBe(0);
  expect(config.channelCooldownMs).toBe(0);
  expect(config.maxPendingPerChannel).toBe(0);
});

test('should reports invalid AI_PROVIDER in-process before exit', () => {
  const exitCodes = [];
  const originalExit = process.exit;
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  process.exit = code => {
    exitCodes.push(code);
    throw new Error('process.exit');
  };

  try {
    reloadModule(configPath, () => {
      process.env.AI_PROVIDER = 'gemeni';
    });
  } catch (error) {
    expect(error.message).toBe('process.exit');
  } finally {
    process.exit = originalExit;
    errorSpy.mockRestore();
    delete process.env.AI_PROVIDER;
  }

  expect(exitCodes).toEqual([1]);
});

test('should exits for invalid AI_PROVIDER', () => {
  const result = spawnSync(process.execPath, ['-e', "process.env.AI_PROVIDER='gemeni'; require('./config');"], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Invalid AI_PROVIDER/);
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

test('should configures secondary model and shard count from env', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    OPENAI_API_KEY: 'sk-test',
    SECONDARY_MODEL_NAME: 'gpt-5.4-mini',
    DISCORD_SHARD_COUNT: 'auto'
  });
  expect(config.secondaryModelName).toBe('gpt-5.4-mini');
  expect(config.secondaryProvider).toBe('openai');
  expect(config.backupModels).toEqual([{ model: 'gpt-5.4-mini', provider: 'openai', tier: 'secondary' }]);
  expect(config.discordShardCount).toBe('auto');

  const numericShards = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    DISCORD_SHARD_COUNT: '4'
  });
  expect(numericShards.discordShardCount).toBe(4);

  const invalidShards = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    DISCORD_SHARD_COUNT: 'not-a-number'
  });
  expect(invalidShards.discordShardCount).toBe(0);
});

test('should disables secondary model when unsupported or matches primary', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const unsupported = loadConfig({
      AI_PROVIDER: 'openai',
      OPENAI_MODEL_NAME: 'gpt-5.4-nano',
      OPENAI_API_KEY: 'sk-test',
      SECONDARY_MODEL_NAME: 'not-a-real-model'
    });
    expect(unsupported.secondaryModelName).toBeNull();
    expect(unsupported.secondaryProvider).toBeNull();
    expect(unsupported.backupModels).toEqual([]);

    const sameModel = loadConfig({
      AI_PROVIDER: 'openai',
      OPENAI_MODEL_NAME: 'gpt-5.4-nano',
      OPENAI_API_KEY: 'sk-test',
      SECONDARY_MODEL_NAME: 'gpt-5.4-nano'
    });
    expect(sameModel.secondaryModelName).toBeNull();
    expect(sameModel.secondaryProvider).toBeNull();
    expect(sameModel.backupModels).toEqual([]);
    expect(warnSpy.mock.calls.some(args => String(args[0]).includes('ALLOWED_GUILD_IDS') || String(args[0]).includes('SECONDARY_MODEL_NAME'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
  }
});

test('should configures cross-provider secondary model when model and API key are available', () => {
  const config = loadConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_MODEL_NAME: 'gemini-3-flash-preview',
    GEMINI_API_KEY: 'gem-test',
    OPENAI_API_KEY: 'sk-test',
    SECONDARY_MODEL_NAME: 'gpt-5.4-mini'
  });
  expect(config.secondaryModelName).toBe('gpt-5.4-mini');
  expect(config.secondaryProvider).toBe('openai');
  expect(config.backupModels).toEqual([{ model: 'gpt-5.4-mini', provider: 'openai', tier: 'secondary' }]);
});

test('should configures tertiary model and provider', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    OPENAI_API_KEY: 'sk-test',
    ANTHROPIC_API_KEY: 'ant-test',
    SECONDARY_MODEL_NAME: 'gpt-5.4-mini',
    TERTIARY_MODEL_NAME: 'claude-haiku-4-5',
    TERTIARY_AI_PROVIDER: 'claude'
  });
  expect(config.backupModels).toEqual([
    { model: 'gpt-5.4-mini', provider: 'openai', tier: 'secondary' },
    { model: 'claude-haiku-4-5', provider: 'claude', tier: 'tertiary' }
  ]);
  expect(config.secondaryModelName).toBe('gpt-5.4-mini');
  expect(config.secondaryProvider).toBe('openai');
  expect(config.tertiaryModelName).toBe('claude-haiku-4-5');
  expect(config.tertiaryProvider).toBe('claude');
});

test('should disables duplicate tertiary model', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const config = loadConfig({
      AI_PROVIDER: 'openai',
      OPENAI_MODEL_NAME: 'gpt-5.4-nano',
      OPENAI_API_KEY: 'sk-test',
      SECONDARY_MODEL_NAME: 'gpt-5.4-mini',
      TERTIARY_MODEL_NAME: 'gpt-5.4-mini'
    });
    expect(config.backupModels).toEqual([{ model: 'gpt-5.4-mini', provider: 'openai', tier: 'secondary' }]);
    expect(warnSpy.mock.calls.some(args => String(args[0]).includes('duplicates'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
  }
});

test('should disables cross-provider secondary model when API key is missing', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const config = loadConfig({
      AI_PROVIDER: 'gemini',
      GEMINI_MODEL_NAME: 'gemini-3-flash-preview',
      GEMINI_API_KEY: 'gem-test',
      SECONDARY_MODEL_NAME: 'gpt-5.4-mini'
    });
    expect(config.secondaryModelName).toBeNull();
    expect(config.secondaryProvider).toBeNull();
    expect(config.backupModels).toEqual([]);
    expect(warnSpy.mock.calls.some(args => String(args[0]).includes('API key'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
  }
});

test('should honors explicit SECONDARY_AI_PROVIDER', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    OPENAI_API_KEY: 'sk-test',
    ANTHROPIC_API_KEY: 'ant-test',
    SECONDARY_AI_PROVIDER: 'claude',
    SECONDARY_MODEL_NAME: 'claude-haiku-4-5'
  });
  expect(config.secondaryModelName).toBe('claude-haiku-4-5');
  expect(config.secondaryProvider).toBe('claude');
});

test('should warns on invalid ALLOWED_GUILD_IDS entries', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    loadConfig({
      AI_PROVIDER: 'openai',
      OPENAI_MODEL_NAME: 'gpt-5.4-nano',
      ALLOWED_GUILD_IDS: 'not-a-snowflake'
    });
    expect(warnSpy.mock.calls.some(args => String(args[0]).includes('ALLOWED_GUILD_IDS'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
  }
});

test('should resolves NVIDIA image generation settings', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    NVIDIA_API_KEY: 'nvapi-test',
    NVIDIA_IMAGE_MODEL: 'flux.1-dev',
    NVIDIA_IMAGE_TIMEOUT_MS: '90000',
    IMAGE_USER_COOLDOWN_MS: '15000'
  });

  expect(config.nvidiaApiKey).toBe('nvapi-test');
  expect(config.nvidiaImageModel).toBe('flux.1-dev');
  expect(config.nvidiaImageTimeoutMs).toBe(90000);
  expect(config.imageUserCooldownMs).toBe(15000);
  expect(config.NVIDIA_IMAGE_MODELS['flux.1-schnell'].apiPath).toBe('black-forest-labs/flux.1-schnell');
  expect(config.NVIDIA_ASPECT_RATIOS['16:9']).toEqual({ width: 1344, height: 768 });
});

test('should fall back to default NVIDIA image model when env model is invalid', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const config = loadConfig({
      AI_PROVIDER: 'openai',
      OPENAI_MODEL_NAME: 'gpt-5.4-nano',
      NVIDIA_IMAGE_MODEL: 'not-a-model'
    });
    expect(config.nvidiaImageModel).toBe('flux.1-schnell');
    expect(warnSpy.mock.calls.some(args => String(args[0]).includes('NVIDIA_IMAGE_MODEL'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
  }
});

test('should warn when SECONDARY_AI_PROVIDER is invalid', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const config = loadConfig({
      AI_PROVIDER: 'openai',
      OPENAI_MODEL_NAME: 'gpt-5.4-nano',
      OPENAI_API_KEY: 'fake',
      SECONDARY_MODEL_NAME: 'gpt-5.4-mini',
      SECONDARY_AI_PROVIDER: 'not-a-provider'
    });
    expect(config.backupModels.length).toBe(0);
    expect(warnSpy.mock.calls.some(args => String(args[0]).includes('SECONDARY_AI_PROVIDER'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
  }
});

test('should warn when backup model is unsupported for explicit provider', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const config = loadConfig({
      AI_PROVIDER: 'openai',
      OPENAI_MODEL_NAME: 'gpt-5.4-nano',
      OPENAI_API_KEY: 'fake',
      SECONDARY_MODEL_NAME: 'claude-sonnet-4-6',
      SECONDARY_AI_PROVIDER: 'openai'
    });
    expect(config.backupModels.length).toBe(0);
    expect(warnSpy.mock.calls.some(args => String(args[0]).includes('not supported for SECONDARY_AI_PROVIDER'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
  }
});

test('should resolve gemini backup provider api key path', () => {
  const config = loadConfig({
    AI_PROVIDER: 'openai',
    OPENAI_MODEL_NAME: 'gpt-5.4-nano',
    OPENAI_API_KEY: 'fake',
    GEMINI_API_KEY: 'gemini-key',
    SECONDARY_MODEL_NAME: 'gemini-3-flash-preview',
    SECONDARY_AI_PROVIDER: 'gemini'
  });
  expect(config.backupModels).toEqual([
    { model: 'gemini-3-flash-preview', provider: 'gemini', tier: 'secondary' }
  ]);
});
