const { Events } = require('discord.js');
const {
  ensureClientChatState,
  getChannelQueueDepth,
  enqueueChannelChat,
  runChannelChat,
  maxPendingPerChannel
} = require('../utils/channelChatHandler');
const { traceReplyChain } = require('../utils/replyChainTracer');
const { withDiscordRetry } = require('../utils/discordApi');
const { serializeError } = require('../utils/logSanitize');
const { recordCount } = require('../instrument');
const path = require('path');
const logger = require('../logger')(path.basename(__filename));
const {
  maxReplyChainDepth,
  allowedGuildIds
} = require('../config');

const SAFE_ALLOWED_MENTIONS = { parse: [] };

/**
 * Detects if a message contains @here or @everyone mentions.
 * @param {import('discord.js').Message} message - The message to check
 * @returns {boolean} True if the message contains @here or @everyone
 */
function hasEveryoneMention(message) {
  return message.mentions.everyone || /@here|@everyone/.test(message.content || '');
}

function messageMentionsBot(message, client) {
  if (message.mentions.users.has(client.user.id)) return true;
  if (!message.guild || !message.mentions.roles?.size) return false;
  const botMember = message.guild.members.cache.get(client.user.id);
  if (!botMember) return false;
  return message.mentions.roles.some(role => botMember.roles.cache.has(role.id));
}

function recordReplyFailure(location, channelId, messageId, err, extra = {}) {
  try {
    const httpStatus = err?.status || err?.statusCode || err?.httpStatus;
    recordCount('discord.api.failure', 1, {
      location,
      channelId,
      messageId,
      errorMessage: err?.message,
      httpStatus,
      ...extra
    });
    if (httpStatus === 429) {
      recordCount('discord.api.rate_limit', 1, {
        location,
        channelId,
        messageId,
        ...extra
      });
    }
  } catch (metricErr) {
    logger.debug('Failed to record discord.api.failure metric.', { errorMessage: metricErr.message });
  }
}

/**
 * Message create event handler module
 * @module events/messageCreate
 */
module.exports = {
  name: Events.MessageCreate,
  /**
   * Handles incoming messages and generates AI responses when appropriate.
   * Processes direct mentions of the bot and replies to the bot's messages.
   * Maintains conversation history per channel, allowing multiple users to participate.
   * Uses per-channel locking to prevent race conditions when multiple messages arrive simultaneously.
   *
   * @param {import('discord.js').Message} message - The message that triggered the event
   * @returns {Promise<void>}
   */
  async execute(message) {
    if (message.author.bot) {
      logger.debug(`Ignoring bot message from ${message.author.tag}.`);
      return;
    }

    const client = message.client;
    if (!client.discordReady || !client.user?.id) {
      logger.debug('Ignoring message before the Discord client is ready.');
      return;
    }

    const channelId = message.channelId;
    const userId = message.author.id;
    const channelName = message.channel?.name || 'unknown';
    const messageStartedAt = Date.now();

    if (allowedGuildIds.size > 0) {
      if (!message.guildId || !allowedGuildIds.has(message.guildId)) {
        logger.debug('Ignoring message from disallowed guild.', {
          guildId: message.guildId || null,
          channelId,
          messageId: message.id
        });
        return;
      }
    }

    const hasBotPing = messageMentionsBot(message, client);
    const hasReference = Boolean(message.reference?.messageId);
    const hasEveryoneOrHereMention = hasEveryoneMention(message);

    if (hasEveryoneOrHereMention && !hasBotPing) {
      logger.debug('Ignoring message containing @here or @everyone because it does not directly mention the bot.', { channelId });
      return;
    }

    if (!hasBotPing && !hasReference) {
      logger.debug('Ignoring message without bot mention or reply reference.', { channelId, messageId: message.id });
      return;
    }

    let prefetchedReferencedMessage = null;
    if (hasReference) {
      try {
        prefetchedReferencedMessage = await message.fetchReference();
      } catch {
        if (!hasBotPing) return;
        prefetchedReferencedMessage = null;
      }
    }

    if (!hasBotPing) {
      if (!prefetchedReferencedMessage || prefetchedReferencedMessage.author.id !== client.user.id) {
        logger.debug('Ignoring reply that does not target the bot.', {
          channelId,
          messageId: message.id,
          referencedMessageId: message.reference?.messageId
        });
        return;
      }
    }

    ensureClientChatState(client);

    const pending = getChannelQueueDepth(client, channelId);
    if (maxPendingPerChannel > 0 && pending >= maxPendingPerChannel) {
      recordCount('discord.message.rejected', 1, {
        reason: 'backpressure'
      });
      try {
        await withDiscordRetry(
          () => message.reply({
            content: "I'm busy in this channel, please try again in a few seconds.",
            allowedMentions: SAFE_ALLOWED_MENTIONS
          }),
          { label: 'messageCreate.backpressure_reply' }
        );
      } catch (err) {
        logger.warn('Failed to send busy/backpressure message.', {
          channelId,
          messageId: message.id,
          label: 'messageCreate.backpressure_reply',
          ...serializeError(err)
        });
        recordReplyFailure('messageCreate.backpressure_reply', channelId, message.id, err);
      }
      return;
    }

    let replyChain = [message];
    if (hasReference) {
      try {
        replyChain = await traceReplyChain(message, message.channel, maxReplyChainDepth);
      } catch (error) {
        logger.warn('Error occurred while tracing reply chain.', {
          channelId,
          messageId: message.id,
          ...serializeError(error)
        });
        replyChain = [message];
      }
    }

    const isReplyToBot = Boolean(
      prefetchedReferencedMessage && prefetchedReferencedMessage.author.id === client.user.id
    );
    const trigger = hasBotPing ? 'mention' : 'reply';
    const userText = (message.content || '').replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '@AI').trim();

    await enqueueChannelChat(client, channelId, async () => {
      await runChannelChat({
        client,
        channelId,
        guildId: message.guildId,
        userId,
        userTag: message.author.tag,
        channelName,
        userText,
        trigger,
        messageId: message.id,
        replyChain,
        isReplyToBot,
        botReferencedMessage: prefetchedReferencedMessage,
        startedAt: messageStartedAt,
        queueDepth: pending + 1,
        errorSource: 'messageCreate',
        delivery: {
          sendUserCooldown: content => withDiscordRetry(
            () => message.reply({ content, allowedMentions: SAFE_ALLOWED_MENTIONS }),
            { label: 'messageCreate.user_cooldown_reply' }
          ),
          sendChannelCooldown: content => withDiscordRetry(
            () => message.reply({ content, allowedMentions: SAFE_ALLOWED_MENTIONS }),
            { label: 'messageCreate.channel_cooldown_reply' }
          ),
          createThinkingPlaceholder: () => withDiscordRetry(
            () => message.reply({
              content: '*Thinking...*',
              allowedMentions: SAFE_ALLOWED_MENTIONS
            }),
            { label: 'messageCreate.thinking_reply' }
          ),
          sendPrimaryResponse: async (content, thinkingPlaceholder) => {
            if (thinkingPlaceholder) {
              try {
                await withDiscordRetry(
                  () => thinkingPlaceholder.edit({
                    content,
                    allowedMentions: SAFE_ALLOWED_MENTIONS
                  }),
                  { label: 'messageCreate.edit_thinking' }
                );
                return true;
              } catch (err) {
                logger.warn('Failed to edit thinking message; falling back to a normal reply.', {
                  channelId,
                  messageId: message.id,
                  label: 'messageCreate.edit_thinking',
                  ...serializeError(err)
                });
                recordReplyFailure('messageCreate.edit_thinking', channelId, message.id, err);
                try {
                  await thinkingPlaceholder.delete();
                } catch (deleteErr) {
                  logger.debug('Failed to delete thinking placeholder.', { errorMessage: deleteErr?.message });
                }
              }
            }

            try {
              await withDiscordRetry(
                () => message.reply({
                  content,
                  allowedMentions: SAFE_ALLOWED_MENTIONS
                }),
                { label: 'messageCreate.reply_fallback' }
              );
              return true;
            } catch (err) {
              logger.error('Failed to send fallback reply.', {
                channelId,
                messageId: message.id,
                label: 'messageCreate.reply_fallback',
                ...serializeError(err, { includeStack: true })
              });
              recordReplyFailure('messageCreate.reply_fallback', channelId, message.id, err);
              return false;
            }
          },
          sendAdditionalChunk: async content => {
            try {
              await withDiscordRetry(
                () => message.reply({
                  content,
                  allowedMentions: SAFE_ALLOWED_MENTIONS
                }),
                { label: 'messageCreate.additional_chunk' }
              );
              return true;
            } catch (err) {
              logger.error('Failed to send additional response chunk.', {
                channelId,
                messageId: message.id,
                label: 'messageCreate.additional_chunk',
                ...serializeError(err, { includeStack: true })
              });
              recordReplyFailure('messageCreate.additional_chunk', channelId, message.id, err);
              return false;
            }
          }
        }
      });
    });
  }
};
