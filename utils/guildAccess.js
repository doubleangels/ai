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
 * @param {string|null|undefined} userId
 * @returns {boolean} True when ALLOWED_USER_IDS is empty or contains userId
 */
function isUserAllowlisted(userId) {
  const allowedUserIds = require('../config').allowedUserIds;
  if (!allowedUserIds || allowedUserIds.size === 0) return true;
  return Boolean(userId) && allowedUserIds.has(userId);
}

/** Key of a guild install in an interaction's authorizingIntegrationOwners (ApplicationIntegrationType.GuildInstall). */
const GUILD_INSTALL_OWNER_KEY = '0';

/**
 * Members of a server the bot is installed in may always use it (the guild allowlist
 * covers those). Everywhere else (DMs, group DMs, user installs in other servers)
 * the user must be on ALLOWED_USER_IDS.
 * @param {import('discord.js').CommandInteraction} interaction
 * @returns {boolean}
 */
function isInteractionUserAllowed(interaction) {
  const viaGuildInstall = Boolean(interaction.guildId)
    && interaction.authorizingIntegrationOwners?.[GUILD_INSTALL_OWNER_KEY] === interaction.guildId;
  return viaGuildInstall || isUserAllowlisted(interaction.user?.id);
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
  logger.info(`Leaving disallowed guild "${guildName}".`, {
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
    logger.info(`Left disallowed guild "${guildName}".`, {
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
    logger.error(`Failed to leave disallowed guild "${guildName}".`, {
      guildId,
      guildName,
      source,
      ...serializeError(error, { includeStack: true })
    });
    return false;
  }
}

/**
 * Leaves every guild not in ALLOWED_GUILD_IDS (no-op when allowlist is empty).
 * @param {import('discord.js').Client} client
 * @param {string} source
 * @returns {Promise<number>}
 */
async function leaveDisallowedGuilds(client, source) {
  const allowedGuildIds = getAllowedGuildIds();
  if (!allowedGuildIds || allowedGuildIds.size === 0) return 0;

  let leftCount = 0;

  // Snapshot first: leave() only issues a REST call, so the cache doesn't reflect
  // it until a later GUILD_DELETE event, and a live iterator could otherwise skip
  // a not-yet-visited guild removed by a concurrent cache mutation mid-loop.
  const guilds = [...client.guilds.cache.values()];
  for (const guild of guilds) {
    if (await leaveDisallowedGuild(client, guild, source)) {
      leftCount += 1;
    }
  }

  if (leftCount > 0) {
    logger.info(`Left ${leftCount} disallowed guild(s).`, {
      source,
      leftCount,
      outcome: 'success'
    });
  }

  return leftCount;
}

module.exports = {
  isGuildAllowlisted,
  isUserAllowlisted,
  isInteractionUserAllowed,
  leaveDisallowedGuild,
  leaveDisallowedGuilds,
  clearGuildConversationState
};
