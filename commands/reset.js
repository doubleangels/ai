const { SlashCommandBuilder, EmbedBuilder, ChannelType, MessageFlags, PermissionFlagsBits } = require('discord.js'); 
const path = require('path');
const { captureError, recordCount, recordDistribution } = require('../instrument');
const { pruneChannelAuxMaps } = require('../utils/aiUtils');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');

function channelBelongsToGuild(client, channelId, guildId) {
  return (client.channelGuildIds?.get(channelId) ?? null) === (guildId ?? null);
}

function collectGuildChannelIds(client, guildId) {
  const ids = new Set();
  for (const channelId of client.conversationHistory.keys()) {
    if (channelBelongsToGuild(client, channelId, guildId)) {
      ids.add(channelId);
    }
  }
  if (client.channelLocks) {
    for (const channelId of client.channelLocks.keys()) {
      if (channelBelongsToGuild(client, channelId, guildId)) {
        ids.add(channelId);
      }
    }
  }
  return [...ids];
}

function clearGuildChannelState(client, channelIds, channelLocks, channelQueueDepth) {
  const channelLastActivity = client.channelLastActivity;
  const channelGuildIds = client.channelGuildIds;
  const channelCooldowns = client.channelCooldowns;

  for (const channelId of channelIds) {
    client.conversationHistory.delete(channelId);
    channelLastActivity?.delete(channelId);
    channelGuildIds?.delete(channelId);
    channelCooldowns?.delete(channelId);
    pruneChannelAuxMaps(channelId, channelLocks, channelQueueDepth, channelGuildIds);
  }
}

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
    .setDescription('Reset conversation history for a channel or all channels in this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription('What channel would you like to reset history for?')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildPublicThread,
          ChannelType.GuildPrivateThread,
          ChannelType.AnnouncementThread
        )
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const client = interaction.client;
    const userId = interaction.user.id;
    const guildName = interaction.guild?.name || 'unknown';
    const startedAt = Date.now();

    const scope = interaction.options.getChannel('channel') ? 'channel' : 'guild';
    const targetChannel = interaction.options.getChannel('channel');

    logger.info('Reset command initiated.', {
      user: interaction.user.tag,
      userId,
      guildId: interaction.guildId,
      guildName,
      interactionId: interaction.id,
      channelId: targetChannel?.id || null,
      scope
    });

    let resetOutcome = 'success';

    try {
      const channelLocks = client.channelLocks || (client.channelLocks = new Map());
      const channelQueueDepth = client.channelQueueDepth || (client.channelQueueDepth = new Map());
      const channelLastActivity = client.channelLastActivity;

      const settleReply = async (embed) => {
        try {
          await interaction.editReply({ embeds: [embed] });
        } catch (editError) {
          logger.warn('Failed to edit reset reply, attempting follow-up.', {
            userId,
            guildId: interaction.guildId,
            interactionId: interaction.id,
            ...serializeError(editError, { includeStack: true })
          });
          try {
            await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
          } catch (followUpError) {
            logger.error('Failed to send reset follow-up reply.', {
              userId,
              guildId: interaction.guildId,
              interactionId: interaction.id,
              ...serializeError(followUpError, { includeStack: true })
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
            resetOutcome = 'no_history';
            logger.debug('Reset command found no conversation history for channel.', {
              channelId,
              channelName,
              scope: 'channel',
              outcome: 'no_history'
            });
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
          channelLastActivity?.delete(channelId);
          client.channelCooldowns?.delete(channelId);
          pruneChannelAuxMaps(channelId, channelLocks, channelQueueDepth, client.channelGuildIds);

          logger.info('Conversation history deleted for channel.', {
            channelId,
            channelName,
            guildId: interaction.guildId,
            previousLength: currentLength,
            scope: 'channel',
            outcome: 'success'
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
        const guildId = interaction.guildId;
        const channelIds = collectGuildChannelIds(client, guildId);

        await runUnderChannelLocks(channelIds, async () => {
          const guildChannelIds = [...client.conversationHistory.keys()]
            .filter(channelId => channelBelongsToGuild(client, channelId, guildId));
          const totalChannels = guildChannelIds.length;
          const totalMessages = guildChannelIds
            .reduce((total, channelId) => total + (client.conversationHistory.get(channelId)?.length || 0), 0);

          if (totalChannels === 0) {
            resetOutcome = 'no_history';
            logger.debug('Reset command found no conversation history in guild.', {
              guildId: interaction.guildId,
              scope: 'guild',
              outcome: 'no_history'
            });
            recordCount('discord.reset.executed', 1, {
              scope: 'guild',
              outcome: 'no_history'
            });
            const embed = new EmbedBuilder()
              .setColor(0xFF0000)
              .setTitle('⚠️ No History Found')
              .setDescription('No conversation history found in this server.');
            await settleReply(embed);
            return;
          }

          clearGuildChannelState(client, guildChannelIds, channelLocks, channelQueueDepth);
          client.userCooldowns?.clear();

          logger.info('Conversation history cleared for guild.', {
            totalChannels,
            totalMessages,
            guildId: interaction.guildId,
            scope: 'guild',
            outcome: 'success'
          });
          recordCount('discord.reset.executed', 1, {
            scope: 'guild',
            outcome: 'success'
          });

          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🗑️ Server History Reset')
            .setDescription(`Conversation history has been reset for this server (${totalChannels} channel${totalChannels === 1 ? '' : 's'} cleared).`);
          await settleReply(embed);
        });
      }

      recordDistribution('discord.reset.duration_ms', Date.now() - startedAt, {
        unit: 'millisecond',
        attributes: {
          scope,
          outcome: resetOutcome
        }
      });
      logger.info('Reset command completed.', {
        userId,
        guildId: interaction.guildId,
        interactionId: interaction.id,
        channelId: targetChannel?.id || null,
        scope,
        durationMs: Date.now() - startedAt,
        outcome: resetOutcome
      });
    } catch (error) {
      resetOutcome = 'error';
      captureError(error, { command: 'reset', handler: 'execute' });
      recordCount('discord.reset.executed', 1, {
        scope: interaction.options.getChannel('channel') ? 'channel' : 'guild',
        outcome: 'error'
      });
      recordDistribution('discord.reset.duration_ms', Date.now() - startedAt, {
        unit: 'millisecond',
        attributes: {
          scope: interaction.options.getChannel('channel') ? 'channel' : 'guild',
          outcome: 'error'
        }
      });
      logger.error('Error executing reset command.', {
        userId,
        guildId: interaction.guildId,
        interactionId: interaction.id,
        scope,
        durationMs: Date.now() - startedAt,
        outcome: 'error',
        ...serializeError(error, { includeStack: true })
      });

      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('⚠️ Error')
        .setDescription('An error occurred while trying to reset the conversation history.');
      try {
        await interaction.editReply({ embeds: [embed] });
      } catch (_) {
        try {
          await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
        } catch (followUpError) {
          logger.error('Failed to send reset error reply.', {
            userId,
            interactionId: interaction.id,
            ...serializeError(followUpError, { includeStack: true })
          });
        }
      }
    }
  },
};
