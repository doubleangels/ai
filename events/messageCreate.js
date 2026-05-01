const { Events } = require('discord.js');
const { generateAIResponse } = require('../utils/aiService');
const { splitMessage, processImageAttachments, createMessageContent, trimConversationHistory, createSystemMessage, SYSTEM_MESSAGES } = require('../utils/aiUtils');
const path = require('path');
const logger = require('../logger')(path.basename(__filename));
const {
  maxHistoryLength,
  maxHistoryTokens,
  modelName,
  aiProvider,
  userCooldownMs,
  channelCooldownMs,
  maxPendingPerChannel
} = require('../config');

const SAFE_ALLOWED_MENTIONS = { parse: [] };

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
    const botMentionPattern = new RegExp(`<@!?${client.user.id}>`);
    const channelId = message.channelId;
    const userId = message.author.id;
    const channelName = message.channel?.name || 'unknown';

    let referencedMessage = null;
    let isReplyToBot = false;
    if (message.reference?.messageId) {
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

    const hasBotMention = message.mentions.users.has(client.user.id) || botMentionPattern.test(message.content);
    if (!hasBotMention && !isReplyToBot) return;

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
      try {
        await message.reply({
          content: "I'm busy in this channel, please try again in a few seconds.",
          allowedMentions: SAFE_ALLOWED_MENTIONS
        });
      } catch (err) {
        logger.warn('Failed to send busy/backpressure message.', {
          channelId,
          errorMessage: err.message
        });
      }
      return;
    }

    const processMessage = async () => {
      const client = message.client;
      const botMentionPattern = new RegExp(`<@!?${client.user.id}>`);
      const channelId = message.channelId;
      const userId = message.author.id;
      const channelName = message.channel?.name || 'unknown';

      let localReferencedMessage = referencedMessage;
      let localIsReplyToBot = isReplyToBot;

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
          logger.warn('Failed to send cooldown reply.', { userId, channelId, errorMessage: err.message });
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
          logger.warn('Failed to send channel cooldown reply.', { channelId, errorMessage: err.message });
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
        isReplyToBot: localIsReplyToBot
      });
      logger.debug(`Processing message from ${message.author.tag} in ${channelName}`);

      let userText = message.content.replace(botMentionPattern, '@AI').trim();

      const messagesToCheckForRef = [];
      if (localReferencedMessage) {
        messagesToCheckForRef.push(localReferencedMessage);
        if (localIsReplyToBot && localReferencedMessage.reference?.messageId) {
          try {
            const parentOfReply = await message.channel.messages.fetch(localReferencedMessage.reference.messageId);
            messagesToCheckForRef.push(parentOfReply);
          } catch (err) {
            logger.debug('Could not fetch parent of replied-to message.', {
              messageId: localReferencedMessage.reference.messageId
            });
          }
        }
      }

      const quotedTextParts = [];
      for (const msg of messagesToCheckForRef) {
        if (msg.author.id === client.user.id) continue;
        const text = (msg.content || '').trim();
        if (text) quotedTextParts.push(text);
      }
      if (quotedTextParts.length > 0) {
        const quotedBlock = quotedTextParts.join('\n\n');
        userText = userText ? `[Replying to:\n${quotedBlock}]\n\n${userText}` : `[Replying to:\n${quotedBlock}]`;
      }

      let imageContents = [];
      if (message.attachments && message.attachments.size > 0) {
        logger.debug(`Processing ${message.attachments.size} attachment(s) from message ${message.id}`);
        imageContents = await processImageAttachments(Array.from(message.attachments.values()));
        logger.info(`Processed ${imageContents.length} image(s) from message ${message.id}`);
      }

      for (const msg of messagesToCheckForRef) {
        if (msg.attachments && msg.attachments.size > 0) {
          const imageAttachments = Array.from(msg.attachments.values()).filter(
            attachment => attachment.contentType && attachment.contentType.startsWith('image/')
          );
          if (imageAttachments.length > 0) {
            logger.debug(`Processing ${imageAttachments.length} image(s) from referenced message ${msg.id}`);
            const processed = await processImageAttachments(imageAttachments);
            imageContents.push(...processed);
            logger.info(`Processed ${processed.length} image(s) from referenced message ${msg.id}`);
          }
        }
      }

      if (!client.conversationHistory.has(channelId)) {
        logger.debug(`No conversation history found for channel ${channelId}.`);
        const systemMessage = createSystemMessage(modelName, aiProvider === 'openai');
        client.conversationHistory.set(channelId, [systemMessage]);
        logger.info(`Created new conversation history for channel ${channelId}.`);
      }

      const channelHistory = client.conversationHistory.get(channelId);

      if (localIsReplyToBot && localReferencedMessage) {
        const lastAssistant = [...channelHistory].reverse().find(m => m.role === 'assistant');
        if (!lastAssistant || lastAssistant.content !== localReferencedMessage.content) {
          logger.debug(`Adding bot's previous response to conversation history for channel ${channelId}.`);
          channelHistory.push({
            role: 'assistant',
            content: localReferencedMessage.content
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
      logger.debug(`Updated conversation history for channel ${channelId}`);

      try {
        logger.info(`Generating AI response for message ${message.id} from ${message.author.tag}.`);

        const reply = await generateAIResponse(channelHistory);

        if (!reply) {
          logger.warn('No reply generated from AI service.');
          if (thinkingMessage) {
            await thinkingMessage.edit({
              content: "⚠️ I couldn't generate a response.",
              allowedMentions: SAFE_ALLOWED_MENTIONS
            });
          } else {
            await message.reply({
              content: "⚠️ I couldn't generate a response.",
              allowedMentions: SAFE_ALLOWED_MENTIONS
            });
          }
          return;
        }

        logger.info(`Sending AI response (${reply.length} chars) for message ${message.id} in channel ${channelId}.`);

        const messageChunks = splitMessage(reply);
        try {
          if (messageChunks.length === 0) {
            const fallback = '⚠️ No response to send.';
            if (thinkingMessage) {
              await thinkingMessage.edit({ content: fallback, allowedMentions: SAFE_ALLOWED_MENTIONS });
            } else {
              await message.reply({ content: fallback, allowedMentions: SAFE_ALLOWED_MENTIONS });
            }
          } else if (messageChunks.length === 1) {
            if (thinkingMessage) {
              await thinkingMessage.edit({
                content: messageChunks[0],
                allowedMentions: SAFE_ALLOWED_MENTIONS
              });
            } else {
              await message.reply({
                content: messageChunks[0],
                allowedMentions: SAFE_ALLOWED_MENTIONS
              });
            }
          } else {
            if (thinkingMessage) {
              await thinkingMessage.edit({
                content: messageChunks[0],
                allowedMentions: SAFE_ALLOWED_MENTIONS
              });
            } else {
              await message.reply({
                content: messageChunks[0],
                allowedMentions: SAFE_ALLOWED_MENTIONS
              });
            }

            for (let i = 1; i < messageChunks.length; i++) {
              await message.reply({
                content: messageChunks[i],
                allowedMentions: SAFE_ALLOWED_MENTIONS
              });
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
        client.userCooldowns.set(userId, Date.now());
        client.channelCooldowns.set(channelId, Date.now());
      } catch (error) {
        logger.error('Error processing message:', {
          error: error.stack,
          message: error.message,
          userId,
          channelId
        });

        if (thinkingMessage) {
          await thinkingMessage.edit({
            content: "⚠️ An error occurred while processing your request.",
            allowedMentions: SAFE_ALLOWED_MENTIONS
          });
        } else {
          await message.reply({
            content: "⚠️ An error occurred while processing your request.",
            allowedMentions: SAFE_ALLOWED_MENTIONS
          });
        }
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
