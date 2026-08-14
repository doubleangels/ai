const { SlashCommandBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType } = require('discord.js');
const path = require('path');
const { captureError, recordCount, recordDistribution } = require('../instrument');
const {
  ensureClientChatState,
  getChannelQueueDepth,
  enqueueChannelChat,
  runChannelChat,
  maxPendingPerChannel
} = require('../utils/channelChatHandler');
const { withDiscordRetry } = require('../utils/discordApi');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');

const SAFE_ALLOWED_MENTIONS = { parse: [] };

/**
 * /chat slash command — same behavior as @mentioning the bot.
 * @module commands/chat
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Chat with the bot (same as @mentioning it)')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
    .addStringOption(option =>
      option
        .setName('message')
        .setDescription('Your message to the bot')
        .setRequired(false)
        .setMaxLength(4000)
    )
    .addAttachmentOption(option =>
      option
        .setName('image')
        .setDescription('Optional image to include with your message')
        .setRequired(false)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @returns {Promise<void>}
   */
  async execute(interaction) {
    const client = interaction.client;
    const userId = interaction.user.id;
    const channelId = interaction.channelId;
    const guildId = interaction.guildId;
    const channelName = interaction.channel?.name || 'unknown';
    const startedAt = Date.now();
    const userText = (interaction.options.getString('message') || '').trim();
    const imageAttachment = interaction.options.getAttachment('image');
    const hasImage = Boolean(imageAttachment);

    if (!userText && !hasImage) {
      logger.debug('Chat command rejected because message and image are both missing.', {
        userId,
        guildId,
        channelId,
        interactionId: interaction.id,
        outcome: 'validation_error'
      });
      await interaction.reply({
        content: '⚠️ Please provide a message or an image.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    logger.info('Chat command initiated.', {
      user: interaction.user.tag,
      userId,
      guildId,
      channelId,
      channelName,
      interactionId: interaction.id,
      messageLength: userText.length,
      hasImage
    });

    ensureClientChatState(client);

    const pending = getChannelQueueDepth(client, channelId);
    if (maxPendingPerChannel > 0 && pending >= maxPendingPerChannel) {
      logger.warn('Chat command rejected because channel queue is full.', {
        userId,
        guildId,
        channelId,
        interactionId: interaction.id,
        queueDepth: pending,
        outcome: 'backpressure'
      });
      recordCount('discord.command.chat.rejected', 1, { reason: 'backpressure' });
      await interaction.reply({
        content: "I'm busy in this channel, please try again in a few seconds.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferReply();

    let outcome = 'success';

    try {
      await enqueueChannelChat(client, channelId, async () => {
        await runChannelChat({
          client,
          channelId,
          guildId,
          userId,
          userTag: interaction.user.tag,
          channelName,
          userText,
          trigger: 'slash',
          messageId: interaction.id,
          replyChain: [],
          extraImageAttachments: imageAttachment ? [imageAttachment] : [],
          startedAt,
          queueDepth: pending + 1,
          errorSource: 'commands/chat',
          delivery: {
            sendUserCooldown: content => interaction.editReply({ content }),
            sendChannelCooldown: content => interaction.editReply({ content }),
            createThinkingPlaceholder: async () => {
              await interaction.editReply({ content: '*Thinking...*' });
              return interaction;
            },
            sendPrimaryResponse: async (content, _thinkingPlaceholder) => {
              try {
                await withDiscordRetry(
                  () => interaction.editReply({
                    content,
                    allowedMentions: SAFE_ALLOWED_MENTIONS
                  }),
                  { label: 'commands/chat.edit_reply' }
                );
                return true;
              } catch (err) {
                logger.error('Failed to edit chat reply.', {
                  userId,
                  channelId,
                  interactionId: interaction.id,
                  ...serializeError(err, { includeStack: true })
                });
                return false;
              }
            },
            sendAdditionalChunk: async content => {
              try {
                await withDiscordRetry(
                  () => interaction.followUp({
                    content,
                    allowedMentions: SAFE_ALLOWED_MENTIONS
                  }),
                  { label: 'commands/chat.follow_up' }
                );
                return true;
              } catch (err) {
                logger.error('Failed to send chat follow-up chunk.', {
                  userId,
                  channelId,
                  interactionId: interaction.id,
                  ...serializeError(err, { includeStack: true })
                });
                return false;
              }
            }
          }
        });
      });
    } catch (error) {
      outcome = 'error';
      captureError(error, {
        source: 'commands/chat',
        userId,
        guildId,
        channelId
      });
      logger.error('Chat command failed.', {
        userId,
        guildId,
        channelId,
        ...serializeError(error, { includeStack: true })
      });

      try {
        await interaction.editReply({
          content: '⚠️ Something went wrong. Please try again.'
        });
      } catch (editError) {
        logger.error('Failed to send chat error reply.', {
          userId,
          channelId,
          ...serializeError(editError, { includeStack: true })
        });
      }
    } finally {
      const elapsedMs = Date.now() - startedAt;
      recordCount('discord.command.chat', 1, { outcome });
      recordDistribution('discord.command.chat.duration_ms', elapsedMs, { outcome });
      logger.info('Chat command completed.', {
        user: interaction.user.tag,
        userId,
        guildId,
        channelId,
        interactionId: interaction.id,
        messageLength: userText.length,
        hasImage,
        outcome,
        elapsedMs
      });
    }
  }
};
