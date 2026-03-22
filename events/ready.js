/**
 * Ready event handler module for the Discord bot.
 * Handles bot initialization, activity setup, and guild information logging.
 * @module events/ready
 */

const { ActivityType, Events } = require('discord.js');
const path = require('path');
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
    try {
      logger.info(`Bot is online: ${client.user.tag}`);
      logger.info(`Using AI model: ${modelName}`);

      client.user.setActivity('for mentions! 📢', { type: ActivityType.Watching });
      logger.info(`Bot activity set to: for mentions! 📢`);

      const guilds = client.guilds.cache;
      const guildList = Array.from(guilds.values())
        .map(guild => `${guild.name} (ID: ${guild.id})`)
        .join(', ');
      logger.info(`Bot is in ${guilds.size} guilds: ${guildList}`);

    } catch (error) {
      logger.error('Error getting guilds:', {
        error: error.stack,
        message: error.message
      });
    }

    logger.info('Bot is ready and setup complete.', {
      readyTimestamp: new Date().toISOString()
    });
  }
};