const path = require('path');
const { stubModule, reloadModule, defaultInstrumentStub } = require('./testUtils.cjs');

const imagePath = path.resolve(__dirname, '..', 'commands', 'image.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const nvidiaServicePath = path.resolve(__dirname, '..', 'utils', 'nvidiaImageService.js');
const aiUtilsPath = path.resolve(__dirname, '..', 'utils', 'aiUtils.js');

function loadImageCommand(options = {}) {
  const nvidiaApiKey = Object.prototype.hasOwnProperty.call(options, 'nvidiaApiKey')
    ? options.nvidiaApiKey
    : 'nvapi-test';
  const imageUserCooldownMs = options.imageUserCooldownMs ?? 0;
  const generateImageImpl = options.generateImageImpl;

  return reloadModule(imagePath, () => {
    stubModule(instrumentPath, defaultInstrumentStub());
    stubModule(configPath, {
      nvidiaApiKey,
      imageUserCooldownMs,
      nvidiaImageModel: 'flux.1-schnell',
      NVIDIA_IMAGE_MODELS: {
        'flux.1-schnell': { apiPath: 'black-forest-labs/flux.1-schnell', label: 'FLUX.1 Schnell', payloadFields: ['prompt', 'width', 'height', 'seed'] }
      },
      NVIDIA_ASPECT_RATIOS: { '1:1': { width: 1024, height: 1024 } }
    });
    stubModule(aiUtilsPath, {
      pruneStaleMapEntries: () => {}
    });
    stubModule(nvidiaServicePath, {
      generateImage: generateImageImpl || (async () => ({
        buffer: Buffer.from('jpeg-bytes'),
        contentType: 'image/jpeg',
        seed: 99,
        modelId: 'flux.1-schnell',
        finishReason: 'SUCCESS',
        aspectRatio: '1:1'
      })),
      formatImageUserMessage: error => error.userMessage || '⚠️ Image generation failed. Please try again.'
    });
  });
}

function createInteraction({ apiKeyConfigured = true, cooldownMs = 0, lastUsed = 0 } = {}) {
  const calls = [];
  const interaction = {
    user: { id: 'user-1', tag: 'User#0001' },
    guildId: 'guild-1',
    channelId: 'chan-1',
    id: 'interaction-1',
    client: {
      imageCooldowns: lastUsed ? new Map([[`image:user-1:chan-1`, lastUsed]]) : new Map()
    },
    options: {
      getString: name => {
        if (name === 'prompt') return 'a blue sky';
        if (name === 'size') return null;
        return null;
      }
    },
    reply: async payload => {
      calls.push({ type: 'reply', payload });
    },
    deferReply: async () => {
      calls.push({ type: 'deferReply' });
    },
    editReply: async payload => {
      calls.push({ type: 'editReply', payload });
    }
  };

  return { interaction, calls, apiKeyConfigured };
}

test('should reject when NVIDIA API key is missing', async () => {
  const command = loadImageCommand({ nvidiaApiKey: undefined });
  const { interaction, calls } = createInteraction();

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'reply' && c.payload.content.match(/not configured/))).toBe(true);
  expect(calls.some(c => c.type === 'deferReply')).toBe(false);
});

test('should block when image cooldown is active', async () => {
  const command = loadImageCommand({ imageUserCooldownMs: 30_000 });
  const { interaction, calls } = createInteraction({ lastUsed: Date.now() });

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'reply' && c.payload.content.match(/wait/i))).toBe(true);
  expect(calls.some(c => c.type === 'deferReply')).toBe(false);
});

test('should defer and reply with attachment on success', async () => {
  const command = loadImageCommand({ imageUserCooldownMs: 30_000 });
  const { interaction, calls } = createInteraction();

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'deferReply')).toBe(true);
  const edit = calls.find(c => c.type === 'editReply');
  expect(edit).toBeTruthy();
  expect(edit.payload.files).toHaveLength(1);
  expect(edit.payload.embeds).toHaveLength(1);
  expect(interaction.client.imageCooldowns.has('image:user-1:chan-1')).toBe(true);
});

test('should edit reply with error message on generation failure', async () => {
  const command = loadImageCommand({
    generateImageImpl: async () => {
      const error = new Error('fail');
      error.userMessage = '⚠️ Rate limited.';
      throw error;
    }
  });
  const { interaction, calls } = createInteraction();

  await command.execute(interaction);

  const edit = calls.find(c => c.type === 'editReply');
  expect(edit.payload.content).toMatch(/Rate limited/);
});

test('should expose slash command metadata', () => {
  const command = loadImageCommand();
  const json = command.data.toJSON();
  expect(json.name).toBe('image');
  expect(json.options.some(o => o.name === 'prompt')).toBe(true);
  expect(json.options.some(o => o.name === 'size')).toBe(true);
  expect(json.options.some(o => o.name === 'model')).toBe(false);
});

test('should truncate long prompts in the success embed', async () => {
  const command = loadImageCommand();
  const longPrompt = 'x'.repeat(300);
  const { interaction, calls } = createInteraction();
  interaction.options.getString = name => {
    if (name === 'prompt') return longPrompt;
    return null;
  };

  await command.execute(interaction);

  const edit = calls.find(c => c.type === 'editReply');
  expect(edit.payload.embeds[0].data.description.length).toBeLessThanOrEqual(256);
  expect(edit.payload.embeds[0].data.description.endsWith('…')).toBe(true);
});

test('should initialize imageCooldowns when client map is missing', async () => {
  const command = loadImageCommand({ imageUserCooldownMs: 30_000 });
  const { interaction } = createInteraction();
  delete interaction.client.imageCooldowns;

  await command.execute(interaction);

  expect(interaction.client.imageCooldowns).toBeInstanceOf(Map);
});

test('should log when error editReply fails', async () => {
  const command = loadImageCommand({
    generateImageImpl: async () => {
      throw new Error('generation failed');
    }
  });
  const { interaction } = createInteraction();
  let editCount = 0;
  interaction.editReply = async () => {
    editCount += 1;
    throw new Error('edit failed');
  };

  await expect(command.execute(interaction)).resolves.toBeUndefined();
  expect(editCount).toBe(1);
});

test('should use model id fallback label for unknown models', async () => {
  const command = loadImageCommand({
    generateImageImpl: async () => ({
      buffer: Buffer.from('jpeg-bytes'),
      contentType: 'image/jpeg',
      seed: 12,
      modelId: 'unknown-model',
      finishReason: 'SUCCESS',
      aspectRatio: '1:1'
    })
  });
  const { interaction, calls } = createInteraction();

  await command.execute(interaction);

  const edit = calls.find(c => c.type === 'editReply');
  expect(edit.payload.embeds[0].data.fields.some(f => f.name === 'Model' && f.value === 'unknown-model')).toBe(true);
});
