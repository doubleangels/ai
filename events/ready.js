/**
 * Ready event handler module for the Discord bot.
 * Handles bot initialization, activity setup, and guild information logging.
 * @module events/ready
 */

const { ActivityType, Events } = require('discord.js');
const path = require('path');
const { captureError, recordCount, recordDistribution, startSpan } = require('../instrument');
const logger = require('../logger')(path.basename(__filename));
const { modelName } = require('../config');

module.exports = {
  name: Events.ClientReady,
  once: true,
  /**
   * Handles the ready event when the bot starts up.
   * Sets up the bot's activity, logs guild information,
   * and initializes conversation history storage.
   * 
   * @param {import('discord.js').Client} client - The Discord client instance
   * @returns {void}
   */
  execute(client) {
    const startedAt = Date.now();
    try {
      startSpan({
        op: 'discord.ready',
        name: 'Client ready'
      }, () => {
        logger.info(`Bot is online as ${client.user.tag}.`);
        logger.info(`Using AI model ${modelName}.`);

        client.user.setPresence({
          activities: [{ name: 'for mentions! 📢', type: ActivityType.Watching }],
          status: 'online',
        });
        logger.info('Bot activity was set to watching for mentions.');

        const guilds = client.guilds.cache;
        const guildList = Array.from(guilds.values())
          .map(guild => `${guild.name} (ID: ${guild.id})`)
          .join(', ');
        logger.info(`Bot is in ${guilds.size} guild(s).`, { guildList });
        recordCount('discord.ready', 1, { outcome: 'success' });
        recordDistribution('discord.ready.duration_ms', Date.now() - startedAt, {
          unit: 'millisecond',
          attributes: { outcome: 'success' }
        });
      });

    } catch (error) {
      captureError(error, { event: 'ready', handler: 'execute' });
      recordCount('discord.ready', 1, { outcome: 'error' });
      recordDistribution('discord.ready.duration_ms', Date.now() - startedAt, {
        unit: 'millisecond',
        attributes: { outcome: 'error' }
      });
      logger.error('Error occurred while getting guild information.', {
        error: error.stack,
        message: error.message
      });
    }

    logger.info('Bot is ready and setup complete.', {
      readyTimestamp: new Date().toISOString()
    });
  }
};