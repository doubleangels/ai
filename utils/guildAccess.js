const path = require('path');
const { captureError, recordCount } = require('../instrument');
const logger = require('../logger')(path.basename(__filename));
const { withDiscordRetry } = require('./discordApi');
const { serializeError } = require('./logSanitize');
const { pruneChannelAuxMaps } = require('./aiUtils');

/**
 * @returns {Set<string>}
 */
function getAllowedGuildIds() {
  return require('../config').allowedGuildIds;
}

/**
 * @param {string|null|undefined} guildId
 * @returns {boolean}
 */
function isGuildAllowlisted(guildId) {
  const allowedGuildIds = getAllowedGuildIds();
  if (!allowedGuildIds || allowedGuildIds.size === 0) return true;
  if (!guildId) return false;
  return allowedGuildIds.has(guildId);
}

/**
 * @param {import('discord.js').Client} client
 */
function ensureGuildLeaveTracking(client) {
  if (!client.guildLeaveInProgress) {
    client.guildLeaveInProgress = new Set();
  }
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 */
function clearGuildConversationState(client, guildId) {
  if (!client.conversationHistory) return;

  const channelIds = [];
  for (const channelId of client.conversationHistory.keys()) {
    if ((client.channelGuildIds?.get(channelId) ?? null) === guildId) {
      channelIds.push(channelId);
    }
  }

  for (const channelId of channelIds) {
    client.conversationHistory.delete(channelId);
    client.channelLastActivity?.delete(channelId);
    client.channelGuildIds?.delete(channelId);
    client.channelCooldowns?.delete(channelId);
    pruneChannelAuxMaps(
      channelId,
      client.channelLocks,
      client.channelQueueDepth,
      client.channelGuildIds
    );
  }
}

/**
 * Leaves a guild that is not in ALLOWED_GUILD_IDS.
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild|null|undefined} guild
 * @param {string} source
 * @returns {Promise<boolean>}
 */
async function leaveDisallowedGuild(client, guild, source) {
  const guildId = guild?.id;
  if (!guildId || !client) return false;
  if (isGuildAllowlisted(guildId)) return false;

  ensureGuildLeaveTracking(client);
  if (client.guildLeaveInProgress.has(guildId)) return false;

  client.guildLeaveInProgress.add(guildId);

  const guildName = guild.name || 'unknown';
  logger.info('Leaving disallowed guild.', {
    guildId,
    guildName,
    source,
    outcome: 'started'
  });

  try {
    await withDiscordRetry(
      () => guild.leave(),
      { label: `guildAccess.leave.${source}` }
    );
    clearGuildConversationState(client, guildId);
    recordCount('discord.guild.left', 1, { source, outcome: 'success' });
    logger.info('Left disallowed guild.', {
      guildId,
      guildName,
      source,
      outcome: 'success'
    });
    return true;
  } catch (error) {
    client.guildLeaveInProgress.delete(guildId);
    captureError(error, { source: 'guildAccess', handler: 'leaveDisallowedGuild', guildId });
    recordCount('discord.guild.left', 1, { source, outcome: 'error' });
    logger.error('Failed to leave disallowed guild.', {
      guildId,
      guildName,
      source,
      ...serializeError(error, { includeStack: true })
    });
    return false;
  }
}

module.exports = {
  isGuildAllowlisted,
  leaveDisallowedGuild,
  clearGuildConversationState
};
