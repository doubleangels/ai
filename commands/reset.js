const { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js'); 
const path = require('path');
const logger = require('../logger')(path.basename(__filename));

/**
 * Reset command module that allows users to reset conversation history.
 * @module commands/reset
 */
module.exports = {
  /**
   * Command data for the reset command.
   * @type {SlashCommandBuilder}
   */
  data: new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset conversation history for a specific channel or all channels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription('What channel would you like to reset history for?')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),
    
  /**
   * Executes the reset command.
   * Resets conversation history for a specific channel or all channels.
   * 
   * @param {import('discord.js').CommandInteraction} interaction - The interaction object
   * @returns {Promise<void>}
   */
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const client = interaction.client;
    const userId = interaction.user.id;
    const guildName = interaction.guild?.name || 'unknown';

    logger.info(`Reset command initiated by ${interaction.user.tag} in guild ${guildName}.`, {
      userId,
      guildId: interaction.guildId
    });

    try {
      const targetChannel = interaction.options.getChannel('channel');
      
      if (targetChannel) {
        const channelId = targetChannel.id;
        const channelName = targetChannel.name;
        
        if (!client.conversationHistory.has(channelId)) {
          logger.debug(`Reset command failed - no conversation history found for channel ${channelId}.`);
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('⚠️ No History Found')
            .setDescription(`No conversation history found for channel #${channelName}.`);
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        const channelHistory = client.conversationHistory.get(channelId);
        const currentLength = channelHistory.length;

        client.conversationHistory.delete(channelId);
        
        logger.info(`Conversation history deleted for channel ${channelId} (#${channelName}).`, {
          previousLength: currentLength
        });

        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('🗑️ Channel History Reset')
          .setDescription(`Conversation history has been reset for channel #${channelName}.`);
        await interaction.editReply({ embeds: [embed] });
      } else {
        const totalChannels = client.conversationHistory.size;
        const totalMessages = Array.from(client.conversationHistory.values())
          .reduce((total, history) => total + history.length, 0);

        if (totalChannels === 0) {
          logger.debug(`Reset command failed - no conversation history found in any channel.`);
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('⚠️ No History Found')
            .setDescription('No conversation history found in any channel.');
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        client.conversationHistory.clear();
        
        logger.info(`All conversation history cleared across ${totalChannels} channels.`, {
          totalChannels,
          totalMessages
        });

        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('🗑️ All History Reset')
          .setDescription(`Conversation history has been reset for all channels (${totalChannels} channels cleared).`);
        await interaction.editReply({ embeds: [embed] });
      }
    } catch (error) {
      logger.error(`Error executing reset command.`, {
        error: error.stack,
        userId,
        message: error.message
      });

      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('⚠️ Error')
        .setDescription('An error occurred while trying to reset the conversation history.');
      try {
        await interaction.deleteReply();
      } catch (_) {
        // Reply may already be deleted or used; still try to send error via followUp
      }
      await interaction.followUp({ embeds: [embed], ephemeral: true });
    }
  },
};
