const path = require('path');
const { stubModule, reloadModule, defaultInstrumentStub } = require('./testUtils.cjs');

const imaginePath = path.resolve(__dirname, '..', 'commands', 'imagine.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');
const geminiServicePath = path.resolve(__dirname, '..', 'utils', 'geminiImageService.js');
const aiUtilsPath = path.resolve(__dirname, '..', 'utils', 'aiUtils.js');

function loadImagineCommand(options = {}) {
  const geminiApiKey = Object.prototype.hasOwnProperty.call(options, 'geminiApiKey')
    ? options.geminiApiKey
    : 'gemini-test';
  const imageUserCooldownMs = options.imageUserCooldownMs ?? 0;
  const generateImageImpl = options.generateImageImpl;

  return reloadModule(imaginePath, () => {
    stubModule(instrumentPath, defaultInstrumentStub());
    stubModule(configPath, {
      geminiApiKey,
      imageUserCooldownMs,
      IMAGE_ASPECT_RATIOS: {
        '1:1': '1:1',
        '16:9': '16:9'
      }
    });
    stubModule(aiUtilsPath, {
      pruneStaleMapEntries: () => {}
    });
    stubModule(geminiServicePath, {
      generateImage: generateImageImpl || (async () => ({
        buffer: Buffer.from('png-bytes'),
        contentType: 'image/png',
        modelId: 'gemini-3.1-flash-image',
        aspectRatio: '1:1'
      })),
      formatImageUserMessage: error => error.userMessage || '⚠️ Image generation failed. Please try again.'
    });
  });
}

function createInteraction({ lastUsed = 0 } = {}) {
  const calls = [];
  const interaction = {
    user: { id: 'user-1', tag: 'User#0001' },
    guildId: 'guild-1',
    channelId: 'chan-1',
    id: 'interaction-1',
    client: {
      imagineCooldowns: lastUsed ? new Map([[`imagine:user-1:chan-1`, lastUsed]]) : new Map()
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

  return { interaction, calls };
}

test('should reject when Gemini API key is missing', async () => {
  const command = loadImagineCommand({ geminiApiKey: undefined });
  const { interaction, calls } = createInteraction();

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'reply' && c.payload.content.match(/not configured/))).toBe(true);
  expect(calls.some(c => c.type === 'deferReply')).toBe(false);
});

test('should block when imagine cooldown is active', async () => {
  const command = loadImagineCommand({ imageUserCooldownMs: 30_000 });
  const { interaction, calls } = createInteraction({ lastUsed: Date.now() });

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'reply' && c.payload.content.match(/wait/i))).toBe(true);
  expect(calls.some(c => c.type === 'deferReply')).toBe(false);
});

test('should defer and reply with attachment on success', async () => {
  const command = loadImagineCommand({ imageUserCooldownMs: 30_000 });
  const { interaction, calls } = createInteraction();

  await command.execute(interaction);

  expect(calls.some(c => c.type === 'deferReply')).toBe(true);
  const edit = calls.find(c => c.type === 'editReply');
  expect(edit).toBeTruthy();
  expect(edit.payload.files).toHaveLength(1);
  expect(edit.payload.embeds).toHaveLength(1);
  expect(interaction.client.imagineCooldowns.has('imagine:user-1:chan-1')).toBe(true);
});

test('should edit reply with error message on generation failure', async () => {
  const command = loadImagineCommand({
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
  const command = loadImagineCommand();
  const json = command.data.toJSON();
  expect(json.name).toBe('imagine');
  expect(json.options.some(o => o.name === 'prompt')).toBe(true);
  expect(json.options.some(o => o.name === 'size')).toBe(true);
  expect(json.options.some(o => o.name === 'model')).toBe(false);
});

test('should truncate long prompts in the success embed', async () => {
  const command = loadImagineCommand();
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

test('should initialize imagineCooldowns when client map is missing', async () => {
  const command = loadImagineCommand({ imageUserCooldownMs: 30_000 });
  const { interaction } = createInteraction();
  delete interaction.client.imagineCooldowns;

  await command.execute(interaction);

  expect(interaction.client.imagineCooldowns).toBeInstanceOf(Map);
});

test('should log when error editReply fails', async () => {
  const command = loadImagineCommand({
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

test('should not include model, size, or seed fields in the success embed', async () => {
  const command = loadImagineCommand();
  const { interaction, calls } = createInteraction();

  await command.execute(interaction);

  const edit = calls.find(c => c.type === 'editReply');
  const fields = edit.payload.embeds[0].data.fields ?? [];
  expect(fields.some(f => f.name === 'Model')).toBe(false);
  expect(fields.some(f => f.name === 'Size')).toBe(false);
  expect(fields.some(f => f.name === 'Seed')).toBe(false);
});
