const { SlashCommandBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType } = require('discord.js');
const path = require('path');
const { recordCount } = require('../instrument');
const { pruneChannelAuxMaps } = require('../utils/aiUtils');
const logger = require('../logger')(path.basename(__filename));

/**
 * /forget — clears the bot's memory of the current DM or group DM.
 * /reset is admin-only and server-scoped, so without this, user-install
 * conversations outside servers could only be cleared by idle eviction.
 * @module commands/forget
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('forget')
    .setDescription('Clear the conversation history for this DM')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @returns {Promise<void>}
   */
  async execute(interaction) {
    const client = interaction.client;
    const channelId = interaction.channelId;

    // Defer first: waiting on an in-flight AI reply can exceed Discord's 3s reply window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Wait for any in-flight reply in this channel so it can't re-add history after the clear.
    const pendingLock = client.channelLocks?.get(channelId);
    if (pendingLock) await pendingLock.catch(() => undefined);

    const hadHistory = Boolean(client.conversationHistory?.delete(channelId));
    client.channelLastActivity?.delete(channelId);
    client.channelCooldowns?.delete(channelId);
    pruneChannelAuxMaps(channelId, client.channelLocks, client.channelQueueDepth, client.channelGuildIds);

    const outcome = hadHistory ? 'success' : 'no_history';
    recordCount('discord.forget.executed', 1, { outcome });
    logger.info('Forget command completed.', {
      userId: interaction.user.id,
      channelId,
      interactionId: interaction.id,
      outcome
    });

    await interaction.editReply({
      content: hadHistory
        ? '🗑️ Conversation history cleared for this DM.'
        : 'There is no conversation history to clear here.'
    });
  }
};
