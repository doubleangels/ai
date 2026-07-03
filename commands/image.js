const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const path = require('path');
const { captureError, recordCount, recordDistribution } = require('../instrument');
const { nvidiaApiKey, imageUserCooldownMs, nvidiaImageModel, NVIDIA_ASPECT_RATIOS } = require('../config');
const { generateImage, formatImageUserMessage } = require('../utils/nvidiaImageService');
const { pruneStaleMapEntries } = require('../utils/aiUtils');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');

function imageCooldownKey(userId, channelId) {
  return `image:${userId}:${channelId}`;
}

function truncatePrompt(prompt, maxLen = 256) {
  if (!prompt || prompt.length <= maxLen) return prompt;
  return `${prompt.slice(0, maxLen - 1)}…`;
}

const sizeChoices = [
  { name: 'Square 1:1', value: '1:1' },
  { name: 'Landscape 16:9', value: '16:9' },
  { name: 'Portrait 9:16', value: '9:16' },
  { name: 'Portrait 4:5', value: '4:5' },
  { name: 'Landscape 3:2', value: '3:2' }
].filter(choice => NVIDIA_ASPECT_RATIOS[choice.value]);

/**
 * /image slash command — text-to-image via NVIDIA NIM.
 * @module commands/image
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('image')
    .setDescription('Generate an image from a text prompt using NVIDIA NIM')
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('Describe the image you want to generate')
        .setRequired(true)
        .setMaxLength(1000)
    )
    .addStringOption(option => {
      const opt = option
        .setName('size')
        .setDescription('Aspect ratio')
        .setRequired(false);
      for (const choice of sizeChoices) {
        opt.addChoices(choice);
      }
      return opt;
    }),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @returns {Promise<void>}
   */
  async execute(interaction) {
    const client = interaction.client;
    const userId = interaction.user.id;
    const channelId = interaction.channelId;
    const startedAt = Date.now();

    if (!nvidiaApiKey) {
      await interaction.reply({
        content: '⚠️ Image generation is not configured (missing NVIDIA API key).',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (!client.imageCooldowns) {
      client.imageCooldowns = new Map();
    }

    const cooldownKey = imageCooldownKey(userId, channelId);
    const now = Date.now();
    const lastUsed = client.imageCooldowns.get(cooldownKey) || 0;
    if (imageUserCooldownMs > 0 && now - lastUsed < imageUserCooldownMs) {
      const waitSec = Math.ceil((imageUserCooldownMs - (now - lastUsed)) / 1000);
      await interaction.reply({
        content: `⚠️ Please wait ${waitSec}s before generating another image.`,
        flags: MessageFlags.Ephemeral
      });
      recordCount('discord.command.image.cooldown', 1);
      return;
    }

    const prompt = interaction.options.getString('prompt', true);
    const modelId = nvidiaImageModel;
    const aspectRatio = interaction.options.getString('size') || '1:1';

    await interaction.deferReply();

    logger.info('Image command initiated.', {
      user: interaction.user.tag,
      userId,
      guildId: interaction.guildId,
      channelId,
      interactionId: interaction.id,
      modelId,
      aspectRatio,
      promptLength: prompt.length
    });

    let outcome = 'success';

    try {
      const result = await generateImage({ prompt, modelId, aspectRatio });

      const filename = `image-${result.seed}.jpg`;
      const attachment = new AttachmentBuilder(result.buffer, { name: filename });

      const embed = new EmbedBuilder()
        .setColor(0x76b900)
        .setTitle('Generated image')
        .setDescription(truncatePrompt(prompt))
        .setFooter({ text: `Requested by ${interaction.user.tag}` })
        .setImage(`attachment://${filename}`);

      await interaction.editReply({ embeds: [embed], files: [attachment] });

      if (imageUserCooldownMs > 0) {
        pruneStaleMapEntries(client.imageCooldowns, imageUserCooldownMs * 10);
        client.imageCooldowns.set(cooldownKey, Date.now());
      }
    } catch (error) {
      outcome = 'error';
      captureError(error, {
        source: 'commands/image',
        userId,
        guildId: interaction.guildId,
        channelId,
        modelId
      });
      logger.error('Image command failed.', {
        userId,
        guildId: interaction.guildId,
        channelId,
        modelId,
        ...serializeError(error, { includeStack: true })
      });

      try {
        await interaction.editReply({ content: formatImageUserMessage(error) });
      } catch (editError) {
        logger.error('Failed to send image error reply.', {
          userId,
          channelId,
          ...serializeError(editError, { includeStack: true })
        });
      }
    } finally {
      const elapsedMs = Date.now() - startedAt;
      recordCount('discord.command.image', 1, { outcome });
      recordDistribution('discord.command.image.duration_ms', elapsedMs, { outcome });
      logger.info('Image command completed.', {
        userId,
        guildId: interaction.guildId,
        channelId,
        outcome,
        elapsedMs
      });
    }
  }
};
