const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const path = require('path');
const { captureError, recordCount, recordDistribution } = require('../instrument');
const { geminiApiKey, imageUserCooldownMs, IMAGE_ASPECT_RATIOS } = require('../config');
const { generateImage, formatImageUserMessage } = require('../utils/geminiImageService');
const { pruneStaleMapEntries } = require('../utils/aiUtils');
const { withDiscordRetry } = require('../utils/discordApi');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');

function imagineCooldownKey(userId, channelId) {
  return `imagine:${userId}:${channelId}`;
}

function truncatePrompt(prompt, maxLen = 256) {
  if (!prompt || prompt.length <= maxLen) return prompt;
  return `${prompt.slice(0, maxLen - 1)}…`;
}

const sizeChoices = [
  { name: 'Square 1:1', value: '1:1' },
  { name: 'Landscape 16:9', value: '16:9' },
  { name: 'Portrait 9:16', value: '9:16' },
  { name: 'Portrait 3:4', value: '3:4' },
  { name: 'Landscape 4:3', value: '4:3' }
].filter(choice => IMAGE_ASPECT_RATIOS[choice.value]);

/**
 * /imagine slash command — text-to-image via Gemini Image.
 * @module commands/imagine
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('imagine')
    .setDescription('Generate an image from a text prompt using Gemini Image')
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('What do you want to see in the image?')
        .setRequired(true)
        .setMaxLength(1000)
    )
    .addStringOption(option => {
      const opt = option
        .setName('size')
        .setDescription('What size do you want the image to be?')
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

    if (!geminiApiKey) {
      logger.warn('Imagine command rejected because Gemini API key is missing.', {
        userId,
        guildId: interaction.guildId,
        channelId,
        interactionId: interaction.id,
        outcome: 'missing_api_key'
      });
      await interaction.reply({
        content: '⚠️ Image generation is not configured (missing Gemini API key).',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (!client.imagineCooldowns) {
      client.imagineCooldowns = new Map();
    }

    const cooldownKey = imagineCooldownKey(userId, channelId);
    const now = Date.now();
    const lastUsed = client.imagineCooldowns.get(cooldownKey) || 0;
    if (imageUserCooldownMs > 0 && now - lastUsed < imageUserCooldownMs) {
      const waitSec = Math.ceil((imageUserCooldownMs - (now - lastUsed)) / 1000);
      logger.debug('Imagine command rejected because user cooldown is active.', {
        userId,
        guildId: interaction.guildId,
        channelId,
        interactionId: interaction.id,
        waitSec,
        outcome: 'cooldown'
      });
      await interaction.reply({
        content: `⚠️ Please wait ${waitSec}s before generating another image.`,
        flags: MessageFlags.Ephemeral
      });
      recordCount('discord.command.imagine.cooldown', 1);
      return;
    }

    const prompt = interaction.options.getString('prompt', true);
    const aspectRatio = interaction.options.getString('size') || '1:1';

    await interaction.deferReply();
    await interaction.editReply({ content: '*Thinking...*' });

    logger.info('Imagine command initiated.', {
      user: interaction.user.tag,
      userId,
      guildId: interaction.guildId,
      channelId,
      interactionId: interaction.id,
      aspectRatio,
      promptLength: prompt.length
    });

    let outcome = 'success';

    try {
      const result = await generateImage({ prompt, aspectRatio });

      const ext = result.contentType === 'image/jpeg' ? 'jpg' : 'png';
      const filename = `image-${Date.now()}.${ext}`;
      const attachment = new AttachmentBuilder(result.buffer, { name: filename });

      const embed = new EmbedBuilder()
        .setColor(0x4285f4)
        .setTitle('Generated Image')
        .setDescription(truncatePrompt(prompt))
        .setFooter({ text: `Requested by ${interaction.user.tag}` })
        .setImage(`attachment://${filename}`);

      await withDiscordRetry(
        () => interaction.editReply({
          content: '',
          embeds: [embed],
          files: [attachment]
        }),
        { label: 'commands/imagine.edit_reply' }
      );

      logger.info('Imagine command generated image.', {
        userId,
        guildId: interaction.guildId,
        channelId,
        interactionId: interaction.id,
        modelId: result.modelId,
        aspectRatio: result.aspectRatio,
        bytes: result.buffer.length,
        outcome: 'success'
      });

      if (imageUserCooldownMs > 0) {
        pruneStaleMapEntries(client.imagineCooldowns, imageUserCooldownMs * 10);
        client.imagineCooldowns.set(cooldownKey, Date.now());
      }
    } catch (error) {
      outcome = 'error';
      captureError(error, {
        source: 'commands/imagine',
        userId,
        guildId: interaction.guildId,
        channelId
      });
      logger.error('Imagine command failed.', {
        userId,
        guildId: interaction.guildId,
        channelId,
        ...serializeError(error, { includeStack: true })
      });

      try {
        await withDiscordRetry(
          () => interaction.editReply({ content: formatImageUserMessage(error) }),
          { label: 'commands/imagine.error_reply' }
        );
      } catch (editError) {
        logger.error('Failed to send imagine error reply.', {
          userId,
          channelId,
          ...serializeError(editError, { includeStack: true })
        });
      }
    } finally {
      const elapsedMs = Date.now() - startedAt;
      recordCount('discord.command.imagine', 1, { outcome });
      recordDistribution('discord.command.imagine.duration_ms', elapsedMs, { outcome });
      logger.info('Imagine command completed.', {
        user: interaction.user.tag,
        userId,
        guildId: interaction.guildId,
        channelId,
        interactionId: interaction.id,
        aspectRatio,
        promptLength: prompt.length,
        outcome,
        elapsedMs
      });
    }
  }
};
