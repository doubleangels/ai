const { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js'); 
const path = require('path');
const { captureError, recordCount, recordDistribution } = require('../instrument');
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
    const startedAt = Date.now();

    logger.info(`Reset command initiated by ${interaction.user.tag} in guild ${guildName}.`, {
      userId,
      guildId: interaction.guildId
    });

    try {
      const targetChannel = interaction.options.getChannel('channel');
      const channelLocks = client.channelLocks || (client.channelLocks = new Map());

      const settleReply = async (embed) => {
        try {
          await interaction.editReply({ embeds: [embed] });
        } catch (editError) {
          logger.warn('Failed to edit reset reply, attempting follow-up.', {
            error: editError.stack,
            message: editError.message,
            userId,
            guildId: interaction.guildId
          });
          try {
            await interaction.followUp({ embeds: [embed], ephemeral: true });
          } catch (followUpError) {
            logger.error('Failed to send reset follow-up reply.', {
              error: followUpError.stack,
              message: followUpError.message,
              userId,
              guildId: interaction.guildId
            });
          }
        }
      };

      const runUnderChannelLocks = async (channelIds, operation) => {
        const uniqueChannelIds = [...new Set(channelIds.filter(Boolean))];
        const previousLocks = uniqueChannelIds.map(channelId => channelLocks.get(channelId) || Promise.resolve());
        const queuedOperation = (async () => {
          await Promise.all(previousLocks.map(lock => lock.catch(() => undefined)));
          return operation();
        })();

        const settledOperation = queuedOperation.catch(() => undefined);
        for (const channelId of uniqueChannelIds) {
          channelLocks.set(channelId, settledOperation);
        }

        return queuedOperation;
      };
      
      if (targetChannel) {
        const channelId = targetChannel.id;
        const channelName = targetChannel.name;

        await runUnderChannelLocks([channelId], async () => {
          if (!client.conversationHistory.has(channelId)) {
            logger.debug(`Reset command failed - no conversation history found for channel ${channelId}.`);
            recordCount('discord.reset.executed', 1, {
              scope: 'channel',
              outcome: 'no_history'
            });
            const embed = new EmbedBuilder()
              .setColor(0xFF0000)
              .setTitle('⚠️ No History Found')
              .setDescription(`No conversation history found for channel #${channelName}.`);
            await settleReply(embed);
            return;
          }

          const channelHistory = client.conversationHistory.get(channelId);
          const currentLength = channelHistory.length;

          client.conversationHistory.delete(channelId);
          
          logger.info(`Conversation history deleted for channel ${channelId} (#${channelName}).`, {
            previousLength: currentLength
          });
          recordCount('discord.reset.executed', 1, {
            scope: 'channel',
            outcome: 'success'
          });

          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🗑️ Channel History Reset')
            .setDescription(`Conversation history has been reset for channel #${channelName}.`);
          await settleReply(embed);
        });
      } else {
        const channelIds = [...new Set([
          ...client.conversationHistory.keys(),
          ...channelLocks.keys()
        ])];

        await runUnderChannelLocks(channelIds, async () => {
          const totalChannels = client.conversationHistory.size;
          const totalMessages = Array.from(client.conversationHistory.values())
            .reduce((total, history) => total + history.length, 0);

          if (totalChannels === 0) {
            logger.debug(`Reset command failed - no conversation history found in any channel.`);
            recordCount('discord.reset.executed', 1, {
              scope: 'all',
              outcome: 'no_history'
            });
            const embed = new EmbedBuilder()
              .setColor(0xFF0000)
              .setTitle('⚠️ No History Found')
              .setDescription('No conversation history found in any channel.');
            await settleReply(embed);
            return;
          }

          client.conversationHistory.clear();
          
          logger.info(`All conversation history cleared across ${totalChannels} channels.`, {
            totalChannels,
            totalMessages
          });
          recordCount('discord.reset.executed', 1, {
            scope: 'all',
            outcome: 'success'
          });

          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🗑️ All History Reset')
            .setDescription(`Conversation history has been reset for all channels (${totalChannels} channels cleared).`);
          await settleReply(embed);
        });
      }

      recordDistribution('discord.reset.duration_ms', Date.now() - startedAt, {
        unit: 'millisecond',
        attributes: {
          scope: targetChannel ? 'channel' : 'all',
          outcome: 'success'
        }
      });
    } catch (error) {
      captureError(error, { command: 'reset', handler: 'execute' });
      recordCount('discord.reset.executed', 1, {
        scope: interaction.options.getChannel('channel') ? 'channel' : 'all',
        outcome: 'error'
      });
      recordDistribution('discord.reset.duration_ms', Date.now() - startedAt, {
        unit: 'millisecond',
        attributes: {
          scope: interaction.options.getChannel('channel') ? 'channel' : 'all',
          outcome: 'error'
        }
      });
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
        await interaction.editReply({ embeds: [embed] });
      } catch (_) {
        try {
          await interaction.followUp({ embeds: [embed], ephemeral: true });
        } catch (followUpError) {
          logger.error('Failed to send reset error reply.', {
            error: followUpError.stack,
            userId,
            message: followUpError.message
          });
        }
      }
    }
  },
};
