/**
 * Ready event handler module for the Discord bot.
 * Handles bot initialization, activity setup, and guild information logging.
 * @module events/ready
 */

const fs = require('fs');
const { ActivityType, Events } = require('discord.js');
const path = require('path');

const READY_MARKER_PATH = '/tmp/discord-bot-ready';
const { captureError, recordCount, recordDistribution, startSpan } = require('../instrument');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');
const { modelName, aiProvider, clientId } = require('../config');

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
        client.discordReady = true;
        try {
          fs.writeFileSync(READY_MARKER_PATH, String(Date.now()));
        } catch (writeErr) {
          logger.warn('Failed to write Discord ready marker file.', serializeError(writeErr));
        }

        logger.info('Bot is online.', {
          user: client.user.tag,
          userId: client.user.id,
          clientId: clientId || client.user.id
        });
        logger.info('AI configuration loaded.', {
          aiProvider,
          modelName
        });

        client.user.setPresence({
          activities: [{ name: 'for mentions! 📢', type: ActivityType.Watching }],
          status: 'online',
        });
        logger.info('Bot activity was set to watching for mentions.');

        const guilds = client.guilds.cache;
        const readyDurationMs = Date.now() - startedAt;
        logger.info('Bot guild summary.', {
          guildCount: guilds.size,
          shardId: client.shard?.ids?.[0] ?? 0,
          shardCount: client.shard?.count ?? 1,
          readyDurationMs,
          outcome: 'success'
        });
        recordCount('discord.ready', 1, { outcome: 'success' });
        recordDistribution('discord.ready.duration_ms', readyDurationMs, {
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
        readyDurationMs: Date.now() - startedAt,
        outcome: 'error',
        ...serializeError(error, { includeStack: true })
      });
    }
  }
};
