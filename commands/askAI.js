const { ContextMenuCommandBuilder, ApplicationCommandType, MessageFlags, ApplicationIntegrationType, InteractionContextType } = require('discord.js');
const path = require('path');
const { captureError, recordCount, recordDistribution } = require('../instrument');
const {
  ensureClientChatState,
  getChannelQueueDepth,
  enqueueChannelChat,
  runChannelChat,
  maxPendingPerChannel
} = require('../utils/channelChatHandler');
const { collectReplyChainMedia } = require('../utils/aiUtils');
const { maxReplyChainImages } = require('../config');
const { createInteractionDelivery } = require('./chat');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');

/**
 * "Ask AI" message context menu (right-click a message → Apps → Ask AI).
 * Works wherever the app is user-installed, including servers the bot has not joined,
 * where @mentions and replies cannot reach it.
 * @module commands/askAI
 */
module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Ask AI')
    .setType(ApplicationCommandType.Message)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

  /**
   * @param {import('discord.js').MessageContextMenuCommandInteraction} interaction
   * @returns {Promise<void>}
   */
  async execute(interaction) {
    const client = interaction.client;
    const userId = interaction.user.id;
    const channelId = interaction.channelId;
    const guildId = interaction.guildId;
    const channelName = interaction.channel?.name || 'unknown';
    const startedAt = Date.now();
    const target = interaction.targetMessage;
    const content = (target?.content || '').trim();
    const { attachments } = collectReplyChainMedia(target ? [target] : [], null, { maxImages: maxReplyChainImages });

    if (!content && attachments.length === 0) {
      logger.debug('Ask AI rejected because the target message has no text or images.', {
        userId,
        guildId,
        channelId,
        interactionId: interaction.id,
        targetMessageId: target?.id,
        outcome: 'validation_error'
      });
      await interaction.reply({
        content: '⚠️ That message has no text or images I can read.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    ensureClientChatState(client);

    const pending = getChannelQueueDepth(client, channelId);
    if (maxPendingPerChannel > 0 && pending >= maxPendingPerChannel) {
      recordCount('discord.command.ask_ai.rejected', 1, { reason: 'backpressure' });
      await interaction.reply({
        content: "I'm busy in this channel, please try again in a few seconds.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const authorName = target.author?.username || 'someone';
    const userText = content
      ? `Reply to this message from ${authorName}:\n\n${content}`
      : '';

    logger.info('Ask AI initiated.', {
      user: interaction.user.tag,
      userId,
      guildId,
      channelId,
      interactionId: interaction.id,
      targetMessageId: target.id,
      messageLength: content.length,
      imageCount: attachments.length
    });

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
          trigger: 'context_menu',
          messageId: interaction.id,
          replyChain: [],
          extraImageAttachments: attachments,
          startedAt,
          queueDepth: pending + 1,
          errorSource: 'commands/askAI',
          delivery: createInteractionDelivery(interaction, 'commands/askAI')
        });
      });
    } catch (error) {
      outcome = 'error';
      captureError(error, { source: 'commands/askAI', userId, guildId, channelId });
      logger.error('Ask AI failed.', {
        userId,
        guildId,
        channelId,
        ...serializeError(error, { includeStack: true })
      });

      try {
        await interaction.editReply({ content: '⚠️ Something went wrong. Please try again.' });
      } catch (editError) {
        logger.error('Failed to send Ask AI error reply.', {
          userId,
          channelId,
          ...serializeError(editError, { includeStack: true })
        });
      }
    } finally {
      const elapsedMs = Date.now() - startedAt;
      recordCount('discord.command.ask_ai', 1, { outcome });
      recordDistribution('discord.command.ask_ai.duration_ms', elapsedMs, { outcome });
      logger.info('Ask AI completed.', {
        userId,
        guildId,
        channelId,
        interactionId: interaction.id,
        outcome,
        elapsedMs
      });
    }
  }
};
