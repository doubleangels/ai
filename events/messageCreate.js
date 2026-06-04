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
  return message.mentions.everyone || /@here|@everyone/.test(message.content);
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
    const channelId = message.channelId;
    const userId = message.author.id;
    const channelName = message.channel?.name || 'unknown';
    const messageStartedAt = Date.now();

    if (allowedGuildIds.size > 0) {
      if (!message.guildId || !allowedGuildIds.has(message.guildId)) {
        return;
      }
    }

    const hasBotPing = message.mentions.users.has(client.user.id);
    const hasReference = Boolean(message.reference?.messageId);
    const hasEveryoneOrHereMention = hasEveryoneMention(message);

    // Reject messages with @here or @everyone that don't have a direct bot ping.
    if (hasEveryoneOrHereMention && !hasBotPing) {
      logger.debug('Ignoring message containing @here or @everyone because it does not directly mention the bot.', { channelId });
      return;
    }

    if (!hasBotPing && !hasReference) return;

    let prefetchedReferencedMessage = null;
    if (!hasBotPing && hasReference) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        if (ref.author.id !== client.user.id) return;
        prefetchedReferencedMessage = ref;
      } catch {
        return;
      }
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
        await message.reply({
          content: "I'm busy in this channel, please try again in a few seconds.",
          allowedMentions: SAFE_ALLOWED_MENTIONS
        });
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
            await thinkingMessage.edit({
              content,
              allowedMentions: SAFE_ALLOWED_MENTIONS
            });
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
            thinkingMessage = null;
          }
        }

        try {
          await message.reply({
            content,
            allowedMentions: SAFE_ALLOWED_MENTIONS
          });
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
        isReplyToBot = true;
        logger.debug(`Message ${message.id} is a reply to the bot's message ${botReferencedMessage.id}.`);
      } else if (message.reference && message.reference.messageId) {
        try {
          const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
          isReplyToBot = referencedMessage.author.id === client.user.id;
          if (isReplyToBot) {
            botReferencedMessage = referencedMessage;
            logger.debug(`Message ${message.id} is a reply to the bot's message ${botReferencedMessage.id}.`);
          }
        } catch (error) {
          logger.error(`Failed to fetch referenced message ${message.reference.messageId}.`, {
            error: error.stack,
            messageId: message.id,
            errorMessage: error.message
          });
        }
      }

      // Basic cooldowns to reduce spam/cost.
      const now = Date.now();
      const lastUser = client.userCooldowns.get(userId) || 0;
      if (userCooldownMs > 0 && now - lastUser < userCooldownMs) {
        const waitMs = userCooldownMs - (now - lastUser);
        try {
          await message.reply({
            content: `Please wait ${Math.ceil(waitMs / 1000)}s before asking again.`,
            allowedMentions: SAFE_ALLOWED_MENTIONS
          });
        } catch (err) {
          logger.warn('Failed to send cooldown reply.', { userId, channelId, errorMessage: err?.message });
        }
        return;
      }

      const lastChannel = client.channelCooldowns.get(channelId) || 0;
      if (channelCooldownMs > 0 && now - lastChannel < channelCooldownMs) {
        const waitMs = channelCooldownMs - (now - lastChannel);
        try {
          await message.reply({
            content: `Give me ${Math.ceil(waitMs / 1000)}s, then try again.`,
            allowedMentions: SAFE_ALLOWED_MENTIONS
          });
        } catch (err) {
          logger.warn('Failed to send channel cooldown reply.', { channelId, errorMessage: err?.message });
        }
        return;
      }

      let thinkingMessage;
      try {
        thinkingMessage = await message.reply({
          content: '*Thinking...*',
          allowedMentions: SAFE_ALLOWED_MENTIONS
        });
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

      let userText = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '@AI').trim();

      if (!client.channelLastActivity) {
        client.channelLastActivity = new Map();
      }
      client.channelLastActivity.set(channelId, Date.now());
      pruneConversationHistories(
        client.conversationHistory,
        client.channelLastActivity,
        conversationHistoryMaxChannels,
        conversationHistoryIdleMs
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

      channelHistory.push({
        role: 'user',
        content: finalMessageContent
      });

      trimConversationHistory(channelHistory, maxHistoryLength, maxHistoryTokens);
      logger.debug(`Updated conversation history for channel ${channelId}.`);

      try {
        logger.info(`Generating AI response for message ${message.id} from ${message.author.tag}.`);
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
          recordCount('discord.message.responded', 1, {
            provider: aiProvider,
            outcome: 'empty'
          });
          await sendPrimaryResponse(formatAIUserMessage({ reason: 'unknown', provider: aiProvider }));
          return;
        }

        const replyIsError = isAIUserErrorMessage(reply);
        logger.info(`Sending AI response (${reply.length} chars) for message ${message.id} in channel ${channelId}.`);

        const messageChunks = splitMessage(reply);
        if (messageChunks.length === 0) {
          const fallback = formatAIUserMessage({ reason: 'empty_response', provider: aiProvider });
          await sendPrimaryResponse(fallback);
        } else if (messageChunks.length === 1) {
          await sendPrimaryResponse(messageChunks[0]);
        } else {
          const firstChunkSent = await sendPrimaryResponse(messageChunks[0]);
          if (!firstChunkSent) {
            return;
          }

          for (let i = 1; i < messageChunks.length; i++) {
            try {
              await message.reply({
                content: messageChunks[i],
                allowedMentions: SAFE_ALLOWED_MENTIONS
              });
            } catch (err) {
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
        }

        if (!replyIsError) {
          logger.debug(`Adding AI response to conversation history for channel ${channelId}.`);
          channelHistory.push({
            role: 'assistant',
            content: reply
          });
        }

        logger.info(`Reply sent successfully to ${message.author.tag} in channel ${channelName}.`);
        recordCount('discord.message.responded', 1, {
          provider: aiProvider,
          outcome: replyIsError ? 'error' : 'success'
        });
        if (!replyIsError) {
          recordDistribution('discord.message.response_chars', reply.length, {
            unit: 'byte',
            attributes: {
              provider: aiProvider,
              trigger: hasBotPing ? 'mention' : 'reply'
            }
          });
        }

        // Update cooldown stamps only after a successful AI reply (not user-facing errors).
        if (!replyIsError) {
          const cooldownMaxAge = Math.max(userCooldownMs, channelCooldownMs) * 10 || 600_000;
          pruneStaleMapEntries(client.userCooldowns, cooldownMaxAge);
          pruneStaleMapEntries(client.channelCooldowns, cooldownMaxAge);
          client.userCooldowns.set(userId, Date.now());
          client.channelCooldowns.set(channelId, Date.now());
        }
      } catch (error) {
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
