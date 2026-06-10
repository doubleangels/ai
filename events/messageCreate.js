const { Events } = require('discord.js');
const { generateAIResponse } = require('../utils/aiService');
const {
  splitMessage,
  processImageAttachments,
  collectReplyChainMedia,
  createMessageContent,
  trimConversationHistory,
  createSystemMessage,
  SYSTEM_MESSAGES,
  pruneStaleMapEntries,
  pruneConversationHistories,
  stripImagesFromHistory,
  formatAIUserMessage,
  isAIUserErrorMessage
} = require('../utils/aiUtils');
const { traceReplyChain } = require('../utils/replyChainTracer');
const { withDiscordRetry } = require('../utils/discordApi');
const { Sentry, captureError, recordCount, recordDistribution, recordGauge, startSpan } = require('../instrument');
const path = require('path');
const logger = require('../logger')(path.basename(__filename));
const {
  maxHistoryLength,
  maxHistoryTokens,
  modelName,
  aiProvider,
  userCooldownMs,
  channelCooldownMs,
  maxPendingPerChannel,
  maxReplyChainDepth,
  maxReplyChainImages,
  allowedGuildIds,
  conversationHistoryMaxChannels,
  conversationHistoryIdleMs
} = require('../config');

const SAFE_ALLOWED_MENTIONS = { parse: [] };

/** Max characters from replied-to messages injected into the prompt (saves input tokens). */
const QUOTED_REPLY_CONTEXT_MAX_CHARS = 2000;

/**
 * Detects if a message contains @here or @everyone mentions.
 * @param {import('discord.js').Message} message - The message to check
 * @returns {boolean} True if the message contains @here or @everyone
 */
function hasEveryoneMention(message) {
  return message.mentions.everyone || /@here|@everyone/.test(message.content || '');
}

function userCooldownKey(userId, channelId) {
  return `${userId}:${channelId}`;
}

/**
 * @param {import('discord.js').Message} message
 * @param {import('discord.js').Client} client
 * @returns {boolean}
 */
function messageMentionsBot(message, client) {
  if (message.mentions.users.has(client.user.id)) return true;
  if (!message.guild || !message.mentions.roles?.size) return false;
  const botMember = message.guild.members.cache.get(client.user.id);
  if (!botMember) return false;
  return message.mentions.roles.some(role => botMember.roles.cache.has(role.id));
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
        return;
      }
    }

    const hasBotPing = messageMentionsBot(message, client);
    const hasReference = Boolean(message.reference?.messageId);
    const hasEveryoneOrHereMention = hasEveryoneMention(message);

    // Reject messages with @here or @everyone that don't have a direct bot ping.
    if (hasEveryoneOrHereMention && !hasBotPing) {
      logger.debug('Ignoring message containing @here or @everyone because it does not directly mention the bot.', { channelId });
      return;
    }

    if (!hasBotPing && !hasReference) return;

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
      if (!prefetchedReferencedMessage || prefetchedReferencedMessage.author.id !== client.user.id) return;
    }

    // Initialize channel locks if not already present
    if (!client.channelLocks) {
      client.channelLocks = new Map();
    }
    if (!client.channelQueueDepth) {
      client.channelQueueDepth = new Map();
    }
    if (!client.userCooldowns) {
      client.userCooldowns = new Map();
    }
    if (!client.channelCooldowns) {
      client.channelCooldowns = new Map();
    }

    const pending = client.channelQueueDepth.get(channelId) || 0;
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
        const errorMessage = err?.message;
        const httpStatus = err?.status || err?.statusCode || err?.httpStatus;
        logger.warn('Failed to send busy/backpressure message.', {
          channelId,
          errorMessage
        });
        try {
          recordCount('discord.api.failure', 1, {
            location: 'messageCreate.backpressure_reply',
            channelId,
            errorMessage,
            httpStatus
          });
          if (httpStatus === 429) {
            recordCount('discord.api.rate_limit', 1, {
              location: 'messageCreate.backpressure_reply',
              channelId
            });
          }
        } catch (metricErr) {
          logger.debug('Failed to record discord.api.failure metric.', { errorMessage: metricErr?.message });
        }
      }
      return;
    }

    const processMessage = async () => {
      const sendPrimaryResponse = async (content) => {
        if (thinkingMessage) {
          try {
            await withDiscordRetry(
              () => thinkingMessage.edit({
                content,
                allowedMentions: SAFE_ALLOWED_MENTIONS
              }),
              { label: 'messageCreate.edit_thinking' }
            );
            return true;
          } catch (err) {
            const errorMessage = err?.message;
            const httpStatus = err?.status || err?.statusCode || err?.httpStatus;
            logger.warn('Failed to edit thinking message; falling back to a normal reply.', {
              channelId,
              messageId: message.id,
              errorMessage
            });
            try {
              recordCount('discord.api.failure', 1, {
                location: 'messageCreate.edit_thinking',
                channelId,
                messageId: message.id,
                errorMessage,
                httpStatus
              });
              if (httpStatus === 429) {
                recordCount('discord.api.rate_limit', 1, {
                  location: 'messageCreate.edit_thinking',
                  channelId,
                  messageId: message.id
                });
              }
            } catch (metricErr) {
              logger.debug('Failed to record discord.api.failure metric.', { errorMessage: metricErr?.message });
            }
            const failedThinking = thinkingMessage;
            thinkingMessage = null;
            try {
              await failedThinking.delete();
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
          const errorMessage = err?.message;
          const httpStatus = err?.status || err?.statusCode || err?.httpStatus;
          logger.error('Failed to send fallback reply.', {
            channelId,
            messageId: message.id,
            error: err?.stack,
            errorMessage
          });
          try {
            recordCount('discord.api.failure', 1, {
              location: 'messageCreate.reply_fallback',
              channelId,
              messageId: message.id,
              errorMessage,
              httpStatus
            });
            if (httpStatus === 429) {
              recordCount('discord.api.rate_limit', 1, {
                location: 'messageCreate.reply_fallback',
                channelId,
                messageId: message.id
              });
            }
          } catch (metricErr) {
            logger.debug('Failed to record discord.api.failure metric.', { errorMessage: metricErr?.message });
          }
          return false;
        }
      };

      let isReplyToBot = false;
      let botReferencedMessage = null;

      if (prefetchedReferencedMessage) {
        botReferencedMessage = prefetchedReferencedMessage;
        isReplyToBot = botReferencedMessage.author.id === client.user.id;
        if (isReplyToBot) {
          logger.debug(`Message ${message.id} is a reply to the bot's message ${botReferencedMessage.id}.`);
        }
      }

      // Basic cooldowns to reduce spam/cost.
      const now = Date.now();
      const cooldownKey = userCooldownKey(userId, channelId);
      const lastUser = client.userCooldowns.get(cooldownKey) || 0;
      if (userCooldownMs > 0 && now - lastUser < userCooldownMs) {
        const waitMs = userCooldownMs - (now - lastUser);
        try {
          await withDiscordRetry(
            () => message.reply({
              content: `Please wait ${Math.ceil(waitMs / 1000)}s before asking again in this channel.`,
              allowedMentions: SAFE_ALLOWED_MENTIONS
            }),
            { label: 'messageCreate.user_cooldown_reply' }
          );
        } catch (err) {
          logger.warn('Failed to send cooldown reply.', { userId, channelId, errorMessage: err?.message });
        }
        return;
      }

      const lastChannel = client.channelCooldowns.get(channelId) || 0;
      if (channelCooldownMs > 0 && now - lastChannel < channelCooldownMs) {
        const waitMs = channelCooldownMs - (now - lastChannel);
        try {
          await withDiscordRetry(
            () => message.reply({
              content: `Give me ${Math.ceil(waitMs / 1000)}s, then try again.`,
              allowedMentions: SAFE_ALLOWED_MENTIONS
            }),
            { label: 'messageCreate.channel_cooldown_reply' }
          );
        } catch (err) {
          logger.warn('Failed to send channel cooldown reply.', { channelId, errorMessage: err?.message });
        }
        return;
      }

      let thinkingMessage;
      try {
        thinkingMessage = await withDiscordRetry(
          () => message.reply({
            content: '*Thinking...*',
            allowedMentions: SAFE_ALLOWED_MENTIONS
          }),
          { label: 'messageCreate.thinking_reply' }
        );
      } catch (err) {
        logger.warn(`Failed to send thinking message in channel ${channelId}.`, {
          errorMessage: err?.message,
          channelId
        });
      }

      logger.info('Message received.', {
        user: message.author.tag,
        userId,
        channelId,
        channelName,
        contentLength: message.content?.length || 0,
        attachmentCount: message.attachments?.size || 0,
        isReplyToBot: isReplyToBot
      });
      logger.debug(`Processing message from ${message.author.tag} in ${channelName}.`);
      recordCount('discord.message.received', 1, {
        provider: aiProvider,
        trigger: hasBotPing ? 'mention' : 'reply'
      });
      recordGauge('discord.channel.queue_depth', pending + 1, {
        provider: aiProvider
      });

      let userText = (message.content || '').replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '@AI').trim();

      if (!client.channelLastActivity) {
        client.channelLastActivity = new Map();
      }
      if (!client.channelGuildIds) {
        client.channelGuildIds = new Map();
      }
      client.channelLastActivity.set(channelId, Date.now());
      client.channelGuildIds.set(channelId, message.guildId ?? null);
      pruneConversationHistories(
        client.conversationHistory,
        client.channelLastActivity,
        conversationHistoryMaxChannels,
        conversationHistoryIdleMs,
        client.channelLocks,
        client.channelQueueDepth,
        client.channelGuildIds
      );

      if (!client.conversationHistory.has(channelId)) {
        logger.debug(`No conversation history found for channel ${channelId}.`);
        const systemMessage = createSystemMessage(modelName, aiProvider === 'openai');
        client.conversationHistory.set(channelId, [systemMessage]);
        logger.info(`Created new conversation history for channel ${channelId}.`);
      }

      const channelHistory = client.conversationHistory.get(channelId);

      // Trace full reply chain for complete context
      let replyChain = [message];
      if (hasReference) {
        try {
          logger.debug('Tracing reply chain for context.', { channelId, messageId: message.id });
          replyChain = await traceReplyChain(message, message.channel, maxReplyChainDepth);
          logger.debug('Reply chain was traced.', { messageCount: replyChain.length, channelId });
        } catch (error) {
          logger.warn('Error occurred while tracing reply chain.', { channelId, error: error.message });
          replyChain = [message];
        }
      }

      // Include referenced reply-chain text so new requests don't accidentally reuse
      // stale translations from earlier turns in the same channel.
      const quotedTextParts = [];
      for (let i = 0; i < replyChain.length - 1; i++) {
        const msg = replyChain[i];
        if (msg.author.id === client.user.id) continue;
        const text = (msg.content || '').trim();
        if (text) quotedTextParts.push(`${msg.author.username}: ${text}`);
      }

      if (quotedTextParts.length > 0) {
        let quotedBlock = quotedTextParts.join('\n');
        if (quotedBlock.length > QUOTED_REPLY_CONTEXT_MAX_CHARS) {
          quotedBlock = `${quotedBlock.slice(0, QUOTED_REPLY_CONTEXT_MAX_CHARS).trimEnd()}\n[truncated]`;
        }
        userText = userText
          ? `[Previous conversation:\n${quotedBlock}]\n\n${userText}`
          : `[Previous conversation:\n${quotedBlock}]`;
      }

      const {
        attachments: chainAttachments,
        truncated: replyChainImagesTruncated,
        attachmentSources,
        embedSources
      } = collectReplyChainMedia(replyChain, client.user.id, { maxImages: maxReplyChainImages });

      let imageContents = [];
      if (chainAttachments.length > 0) {
        logger.debug('Processing reply-chain image media.', {
          channelId,
          messageId: message.id,
          candidateCount: chainAttachments.length,
          attachmentSources,
          embedSources,
          truncated: replyChainImagesTruncated
        });
        imageContents = await processImageAttachments(chainAttachments);
        logger.info('Processed reply-chain images.', {
          channelId,
          messageId: message.id,
          processedCount: imageContents.length,
          replyChainImageCount: chainAttachments.length,
          truncated: replyChainImagesTruncated
        });
      }

      // Add bot's previous response if replying to bot (use fetched parent, not the current user message).
      if (isReplyToBot && botReferencedMessage) {
        const lastAssistant = [...channelHistory].reverse().find(m => m.role === 'assistant');
        if (!lastAssistant || lastAssistant.content !== botReferencedMessage.content) {
          logger.debug(`Adding bot's previous response to conversation history for channel ${channelId}.`);
          channelHistory.push({
            role: 'assistant',
            content: botReferencedMessage.content
          });
        }
      }

      logger.debug(`Adding user message (${message.id}) from ${message.author.tag} to conversation history for channel ${channelId}.`);

      const messageContent = createMessageContent(userText, imageContents);
      let finalMessageContent = messageContent;
      if (imageContents.length > 0 && (!userText || userText.trim() === '')) {
        finalMessageContent = [
          {
            type: 'input_text',
            text: SYSTEM_MESSAGES.IMAGE_DESCRIPTION_PROMPT
          },
          ...imageContents
        ];
      }

      const userTurnIndex = channelHistory.length;
      channelHistory.push({
        role: 'user',
        content: finalMessageContent
      });

      trimConversationHistory(channelHistory, maxHistoryLength, maxHistoryTokens);
      logger.debug(`Updated conversation history for channel ${channelId}.`);

      const rollbackUserTurn = () => {
        while (channelHistory.length > userTurnIndex) {
          channelHistory.pop();
        }
      };

      const applyCooldownStamps = () => {
        if (userCooldownMs <= 0 && channelCooldownMs <= 0) return;
        const cooldownMaxAge = Math.max(userCooldownMs, channelCooldownMs) * 10 || 600_000;
        pruneStaleMapEntries(client.userCooldowns, cooldownMaxAge);
        pruneStaleMapEntries(client.channelCooldowns, cooldownMaxAge);
        if (userCooldownMs > 0) {
          client.userCooldowns.set(userCooldownKey(userId, channelId), Date.now());
        }
        if (channelCooldownMs > 0) {
          client.channelCooldowns.set(channelId, Date.now());
        }
      };

      let aiWasInvoked = false;

      try {
        logger.info(`Generating AI response for message ${message.id} from ${message.author.tag}.`);
        aiWasInvoked = true;
        const reply = await startSpan({
          op: 'discord.message',
          name: 'Generate Discord reply'
        }, async () => {
          if (typeof Sentry.setConversationId === 'function') {
            Sentry.setConversationId(channelId);
          }

          try {
            return await generateAIResponse(channelHistory);
          } finally {
            if (typeof Sentry.setConversationId === 'function') {
              Sentry.setConversationId(null);
            }
          }
        });

        if (!reply?.trim()) {
          logger.warn('No reply generated from AI service.');
          rollbackUserTurn();
          recordCount('discord.message.responded', 1, {
            provider: aiProvider,
            outcome: 'empty'
          });
          await sendPrimaryResponse(formatAIUserMessage({ reason: 'unknown', provider: aiProvider }));
          applyCooldownStamps();
          return;
        }

        const replyIsError = isAIUserErrorMessage(reply);
        logger.info(`Sending AI response (${reply.length} chars) for message ${message.id} in channel ${channelId}.`);

        const messageChunks = splitMessage(reply);
        const deliveredChunks = [];
        let deliveryFailed = false;

        if (messageChunks.length === 0) {
          const fallback = formatAIUserMessage({ reason: 'empty_response', provider: aiProvider });
          if (await sendPrimaryResponse(fallback)) {
            deliveredChunks.push(fallback);
          } else {
            deliveryFailed = true;
          }
        } else if (messageChunks.length === 1) {
          if (await sendPrimaryResponse(messageChunks[0])) {
            deliveredChunks.push(messageChunks[0]);
          } else {
            deliveryFailed = true;
          }
        } else {
          if (await sendPrimaryResponse(messageChunks[0])) {
            deliveredChunks.push(messageChunks[0]);

            for (let i = 1; i < messageChunks.length; i++) {
              try {
                await withDiscordRetry(
                  () => message.reply({
                    content: messageChunks[i],
                    allowedMentions: SAFE_ALLOWED_MENTIONS
                  }),
                  { label: 'messageCreate.additional_chunk' }
                );
                deliveredChunks.push(messageChunks[i]);
              } catch (err) {
                deliveryFailed = true;
                const errorMessage = err?.message;
                const httpStatus = err?.status || err?.statusCode || err?.httpStatus;
                logger.error('Failed to send additional response chunk.', {
                  channelId,
                  messageId: message.id,
                  chunkIndex: i,
                  error: err?.stack,
                  errorMessage
                });
                try {
                  recordCount('discord.api.failure', 1, {
                    location: 'messageCreate.additional_chunk',
                    channelId,
                    messageId: message.id,
                    chunkIndex: i,
                    errorMessage,
                    httpStatus
                  });
                  if (httpStatus === 429) {
                    recordCount('discord.api.rate_limit', 1, {
                      location: 'messageCreate.additional_chunk',
                      channelId,
                      messageId: message.id,
                      chunkIndex: i
                    });
                  }
                } catch (metricErr) {
                  logger.debug('Failed to record discord.api.failure metric.', { errorMessage: metricErr?.message });
                }
                break;
              }
            }
          } else {
            deliveryFailed = true;
          }
        }

        const deliveredContent = deliveredChunks.join('');
        const fullyDelivered = !deliveryFailed
          && deliveredChunks.length > 0
          && deliveredChunks.length === messageChunks.length;
        const partiallyDelivered = !fullyDelivered
          && deliveredChunks.length > 0
          && deliveredChunks.length < messageChunks.length;

        if (!replyIsError && deliveredContent) {
          logger.debug(`Adding AI response to conversation history for channel ${channelId}.`);
          channelHistory.push({
            role: 'assistant',
            content: deliveredContent
          });
        }

        if (deliveryFailed && deliveredChunks.length === 0) {
          logger.warn(`Failed to deliver AI response to ${message.author.tag} in channel ${channelName}.`, {
            channelId,
            messageId: message.id,
            chunkCount: messageChunks.length
          });
          recordCount('discord.message.responded', 1, {
            provider: aiProvider,
            outcome: 'delivery_failed'
          });
        } else if (partiallyDelivered) {
          logger.warn(`Partially delivered AI response to ${message.author.tag} in channel ${channelName}.`, {
            channelId,
            messageId: message.id,
            deliveredChunks: deliveredChunks.length,
            totalChunks: messageChunks.length
          });
          recordCount('discord.message.responded', 1, {
            provider: aiProvider,
            outcome: replyIsError ? 'error' : 'partial'
          });
        } else {
          logger.info(`Reply sent successfully to ${message.author.tag} in channel ${channelName}.`);
          recordCount('discord.message.responded', 1, {
            provider: aiProvider,
            outcome: replyIsError ? 'error' : 'success'
          });
        }

        if (!replyIsError && deliveredContent) {
          recordDistribution('discord.message.response_chars', deliveredContent.length, {
            unit: 'byte',
            attributes: {
              provider: aiProvider,
              trigger: hasBotPing ? 'mention' : 'reply',
              delivery: fullyDelivered ? 'full' : 'partial'
            }
          });
        }

        if (deliveryFailed && deliveredChunks.length === 0 && !replyIsError) {
          rollbackUserTurn();
        }

        applyCooldownStamps();
      } catch (error) {
        if (aiWasInvoked) {
          rollbackUserTurn();
        }
        captureError(error, { event: 'messageCreate', handler: 'processMessage' });
        recordCount('discord.message.responded', 1, {
          provider: aiProvider,
          outcome: 'error'
        });
        logger.error('Error occurred while processing message.', {
          error: error.stack,
          message: error.message,
          userId,
          channelId
        });

        await sendPrimaryResponse(formatAIUserMessage({ error, provider: aiProvider }));
        if (aiWasInvoked) {
          applyCooldownStamps();
        }
      } finally {
        stripImagesFromHistory(channelHistory);
        recordDistribution('discord.message.processing_ms', Date.now() - messageStartedAt, {
          unit: 'millisecond',
          attributes: {
            provider: aiProvider,
            trigger: hasBotPing ? 'mention' : 'reply'
          }
        });
      }
    };

    const previousLock = client.channelLocks.get(channelId) || Promise.resolve();
    client.channelQueueDepth.set(channelId, pending + 1);

    const currentLock = previousLock
      .catch(() => undefined)
      .then(async () => {
        try {
          await processMessage();
        } finally {
          const cur = client.channelQueueDepth.get(channelId) || 1;
          client.channelQueueDepth.set(channelId, Math.max(0, cur - 1));
        }
      });

    client.channelLocks.set(channelId, currentLock.catch(() => undefined));
    await currentLock;
  }
};
