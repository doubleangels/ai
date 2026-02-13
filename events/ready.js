/**
 * Ready event handler module for the Discord bot.
 * Handles bot initialization, activity setup, and guild information logging.
 * @module events/ready
 */

const { ActivityType } = require('discord.js');
const path = require('path');
const logger = require('../logger')(path.basename(__filename));
const { modelName } = require('../config');

const GUILD_ID_TO_LEAVE = '1449885091755982908';

module.exports = {
  name: 'clientReady',
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
    const guildToLeave = client.guilds.cache.get(GUILD_ID_TO_LEAVE);
    if (guildToLeave) {
      guildToLeave.leave().then(() => {
        logger.info(`Left guild ${GUILD_ID_TO_LEAVE} (${guildToLeave.name}).`);
      }).catch(err => {
        logger.error(`Failed to leave guild ${GUILD_ID_TO_LEAVE}.`, {
          error: err?.stack,
          message: err?.message
        });
      });
    }

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