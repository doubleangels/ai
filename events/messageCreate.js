const { Events } = require('discord.js');
const { generateAIResponse } = require('../utils/aiService');
const { splitMessage, processImageAttachments, createMessageContent, trimConversationHistory, createSystemMessage, SYSTEM_MESSAGES } = require('../utils/aiUtils');
const { traceReplyChain, formatChainAsContext } = require('../utils/replyChainTracer');
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
  allowedGuildIds
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
   * Processes messages that mention the bot or are replies to the bot's messages.
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

    const hasBotPing = message.mentions.has(client.user);
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

    // Basic backpressure: avoid unbounded queues per channel.
    const pending = client.channelQueueDepth.get(channelId) || 0;
    if (maxPendingPerChannel > 0 && pending >= maxPendingPerChannel) {
      recordCount('discord.message.rejected', 1, {
        reason: 'backpressure'
      });
      try {
        await message.reply({
          content: "⚠️ I'm busy in this channel—please try again in a few seconds.",
          allowedMentions: SAFE_ALLOWED_MENTIONS
        });
      } catch (err) {
        logger.warn('Failed to send busy/backpressure message.', {
          channelId,
          errorMessage: err.message
        });
        try {
          const httpStatus = err?.status || err?.statusCode || err?.httpStatus;
          recordCount('discord.api.failure', 1, {
            location: 'messageCreate.backpressure_reply',
            channelId,
            errorMessage: err.message,
            httpStatus
          });
          if (httpStatus === 429) {
            recordCount('discord.api.rate_limit', 1, {
              location: 'messageCreate.backpressure_reply',
              channelId
            });
          }
        } catch (metricErr) {
          logger.debug('Failed to record discord.api.failure metric.', { errorMessage: metricErr.message });
        }
      }
      return;
    }

    // Wait for previous message processing to complete, then process this message
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
            logger.warn('Failed to edit thinking message; falling back to a normal reply.', {
              channelId,
              messageId: message.id,
              errorMessage: err.message
            });
            try {
              const httpStatus = err?.status || err?.statusCode || err?.httpStatus;
              recordCount('discord.api.failure', 1, {
                location: 'messageCreate.edit_thinking',
                channelId,
                messageId: message.id,
                errorMessage: err.message,
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
              logger.debug('Failed to record discord.api.failure metric.', { errorMessage: metricErr.message });
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
          logger.error('Failed to send fallback reply.', {
            channelId,
            messageId: message.id,
            error: err.stack,
            errorMessage: err.message
          });
          try {
            const httpStatus = err?.status || err?.statusCode || err?.httpStatus;
            recordCount('discord.api.failure', 1, {
              location: 'messageCreate.reply_fallback',
              channelId,
              messageId: message.id,
              errorMessage: err.message,
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
            logger.debug('Failed to record discord.api.failure metric.', { errorMessage: metricErr.message });
          }
          return false;
        }
      };

      let isReplyToBot = false;
      let referencedMessage = null;

      if (prefetchedReferencedMessage) {
        referencedMessage = prefetchedReferencedMessage;
        isReplyToBot = true;
        logger.debug(`Message ${message.id} is a reply to bot's message: ${referencedMessage.id}.`);
      } else if (message.reference && message.reference.messageId) {
        try {
          referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
          isReplyToBot = referencedMessage.author.id === client.user.id;

          if (isReplyToBot) {
            logger.debug(`Message ${message.id} is a reply to bot's message: ${referencedMessage.id}.`);
          }
        } catch (error) {
          logger.error(`Failed to fetch referenced message ${message.reference.messageId}.`, {
            error: error.stack,
            messageId: message.id,
            errorMessage: error.message
          });
        }
      }

      const hasBotMention = hasBotPing;

      if (!hasBotMention && !isReplyToBot) {
        return;
      }

      const isTriggered = hasBotMention || isReplyToBot;

      // Basic cooldowns to reduce spam/cost.
      const now = Date.now();
      const lastUser = client.userCooldowns.get(userId) || 0;
      if (userCooldownMs > 0 && now - lastUser < userCooldownMs) {
        const waitMs = userCooldownMs - (now - lastUser);
        if (isTriggered) {
          try {
            await message.reply({
              content: `⏳ Please wait ${Math.ceil(waitMs / 1000)}s before asking again.`,
              allowedMentions: SAFE_ALLOWED_MENTIONS
            });
          } catch (err) {
            logger.warn('Failed to send cooldown reply.', { userId, channelId, errorMessage: err.message });
          }
        }
        return;
      }

      const lastChannel = client.channelCooldowns.get(channelId) || 0;
      if (channelCooldownMs > 0 && now - lastChannel < channelCooldownMs) {
        const waitMs = channelCooldownMs - (now - lastChannel);
        if (isTriggered) {
          try {
            await message.reply({
              content: `⏳ Give me ${Math.ceil(waitMs / 1000)}s—then try again.`,
              allowedMentions: SAFE_ALLOWED_MENTIONS
            });
          } catch (err) {
            logger.warn('Failed to send channel cooldown reply.', { channelId, errorMessage: err.message });
          }
        }
        return;
      }

      let thinkingMessage;
      try {
        thinkingMessage = await message.reply({
          content: "*Thinking...*",
          allowedMentions: SAFE_ALLOWED_MENTIONS
        });
      } catch (err) {
        logger.warn(`Failed to send thinking message in channel ${channelId}.`, {
          errorMessage: err.message,
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
        isReplyToBot
      });
      logger.debug(`Processing message from ${message.author.tag} in ${channelName}`);
      recordCount('discord.message.received', 1, {
        provider: aiProvider,
        trigger: hasBotPing ? 'mention' : 'reply'
      });
      recordGauge('discord.channel.queue_depth', pending + 1, {
        provider: aiProvider
      });

      let userText = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '@AI').trim();

      // Trace full reply chain for complete context
      let replyChain = [message];
      if (hasReference) {
        try {
          logger.debug('Tracing reply chain for context', { channelId, messageId: message.id });
          replyChain = await traceReplyChain(message, message.channel);
          logger.debug(`Reply chain traced: ${replyChain.length} messages`, { channelId });
        } catch (error) {
          logger.warn('Error tracing reply chain', { channelId, error: error.message });
          replyChain = [message];
        }
      }

      // Extract text from all messages in the reply chain (except the current message and bot messages)
      const quotedTextParts = [];
      for (let i = 0; i < replyChain.length - 1; i++) {
        const msg = replyChain[i];
        if (msg.author.id === client.user.id) continue;
        const text = (msg.content || '').trim();
        if (text) quotedTextParts.push(`${msg.author.username}: ${text}`);
      }

      // Add chain context if there are previous messages
      if (quotedTextParts.length > 0) {
        let quotedBlock = quotedTextParts.join('\n');
        if (quotedBlock.length > QUOTED_REPLY_CONTEXT_MAX_CHARS) {
          quotedBlock = `${quotedBlock.slice(0, QUOTED_REPLY_CONTEXT_MAX_CHARS).trimEnd()}\n[truncated]`;
        }
        userText = userText ? `[Previous conversation:\n${quotedBlock}]\n\n${userText}` : `[Previous conversation:\n${quotedBlock}]`;
      }

      // Process image attachments from current message
      let imageContents = [];
      if (message.attachments && message.attachments.size > 0) {
        logger.debug(`Processing ${message.attachments.size} attachment(s) from message ${message.id}`);
        imageContents = await processImageAttachments(Array.from(message.attachments.values()));
        logger.info(`Processed ${imageContents.length} image(s) from message ${message.id}`);
      }

      // Include image attachments from the reply chain (images from all messages)
      for (let i = 0; i < replyChain.length - 1; i++) {
        const msg = replyChain[i];
        if (msg.attachments && msg.attachments.size > 0) {
          logger.debug(`Processing ${msg.attachments.size} attachment(s) from chain message ${msg.id}`);
          const processedImages = await processImageAttachments(Array.from(msg.attachments.values()));
          imageContents.push(...processedImages);
          logger.info(`Processed ${processedImages.length} image(s) from chain message ${msg.id}`);
        }
      }

      // Add bot's previous response if replying to bot
      referencedMessage = null;
      if (isReplyToBot && replyChain.length > 0) {
        referencedMessage = replyChain[replyChain.length - 1];
      }

      if (!client.conversationHistory.has(channelId)) {
        logger.debug(`No conversation history found for channel ${channelId}.`);
        const systemMessage = createSystemMessage(modelName, aiProvider === 'openai');
        client.conversationHistory.set(channelId, [systemMessage]);
        logger.info(`Created new conversation history for channel ${channelId}.`);
      }

      const channelHistory = client.conversationHistory.get(channelId);
      
      if (isReplyToBot && referencedMessage) {
        // Avoid duplicating the assistant message if it's already in history.
        const lastAssistant = [...channelHistory].reverse().find(m => m.role === 'assistant');
        if (!lastAssistant || lastAssistant.content !== referencedMessage.content) {
          logger.debug(`Adding bot's previous response to conversation history for channel ${channelId}.`);
          channelHistory.push({
            role: 'assistant',
            content: referencedMessage.content
          });
        }
      }

      logger.debug(`Adding user message (${message.id}) from ${message.author.tag} to conversation history for channel ${channelId}.`);
      
      const messageContent = createMessageContent(userText, imageContents);
      
      let finalMessageContent = messageContent;
      if (imageContents.length > 0) {
        if (!userText || userText.trim() === '') {
          finalMessageContent = [
            {
              type: 'input_text',
              text: SYSTEM_MESSAGES.IMAGE_DESCRIPTION_PROMPT
            },
            ...imageContents
          ];
        }
      }
      
      channelHistory.push({
        role: 'user',
        content: finalMessageContent
      });

      trimConversationHistory(channelHistory, maxHistoryLength, maxHistoryTokens);

      logger.debug(`Updated conversation history for channel ${channelId}`);

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

        if (!reply) {
          logger.warn('No reply generated from AI service.');
          recordCount('discord.message.responded', 1, {
            provider: aiProvider,
            outcome: 'empty'
          });
          await sendPrimaryResponse("⚠️ I couldn't generate a response.");
          return;
        }

        logger.info(`Sending AI response (${reply.length} chars) for message ${message.id} in channel ${channelId}.`);

        const messageChunks = splitMessage(reply);

        try {
          if (messageChunks.length === 0) {
            const fallback = "⚠️ No response to send.";
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
                logger.error('Failed to send additional response chunk.', {
                  channelId,
                  messageId: message.id,
                  chunkIndex: i,
                  error: err.stack,
                  errorMessage: err.message
                });
                  try {
                    const httpStatus = err?.status || err?.statusCode || err?.httpStatus;
                    recordCount('discord.api.failure', 1, {
                      location: 'messageCreate.additional_chunk',
                      channelId,
                      messageId: message.id,
                      chunkIndex: i,
                      errorMessage: err.message,
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
                    logger.debug('Failed to record discord.api.failure metric.', { errorMessage: metricErr.message });
                  }
                break;
              }
            }
          }
        } catch (sendError) {
          logger.error(`Failed to send response for message ${message.id}.`, {
            error: sendError.stack,
            errorMessage: sendError.message
          });
        }

        logger.debug(`Adding AI response to conversation history for channel ${channelId}.`);
        channelHistory.push({
          role: 'assistant',
          content: reply
        });

        logger.info(`Reply sent successfully to ${message.author.tag} in channel: ${channelName}`);
        recordCount('discord.message.responded', 1, {
          provider: aiProvider,
          outcome: 'success'
        });
        recordDistribution('discord.message.response_chars', reply.length, {
          unit: 'byte',
          attributes: {
            provider: aiProvider,
            trigger: hasBotPing ? 'mention' : 'reply'
          }
        });

        // Update cooldown stamps only after successful completion.
        client.userCooldowns.set(userId, Date.now());
        client.channelCooldowns.set(channelId, Date.now());
      } catch (error) {
        captureError(error, { event: 'messageCreate', handler: 'processMessage' });
        recordCount('discord.message.responded', 1, {
          provider: aiProvider,
          outcome: 'error'
        });
        logger.error('Error processing message:', {
          error: error.stack,
          message: error.message,
          userId,
          channelId
        });
        
        await sendPrimaryResponse("⚠️ An error occurred while processing your request.");
      } finally {
        recordDistribution('discord.message.processing_ms', Date.now() - messageStartedAt, {
          unit: 'millisecond',
          attributes: {
            provider: aiProvider,
            trigger: hasBotPing ? 'mention' : 'reply'
          }
        });
      }
    };

    // Chain this message after the previous one. IMPORTANT: never store a rejecting promise,
    // or the channel can get stuck forever.
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

    // Wait for this message to be processed (errors handled inside).
    await currentLock;
  },

};
