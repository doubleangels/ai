const { generateAIResponse } = require('./aiService');
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
} = require('./aiUtils');
const { withDiscordRetry } = require('./discordApi');
const { serializeError } = require('./logSanitize');
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
  maxReplyChainImages,
  conversationHistoryMaxChannels,
  conversationHistoryIdleMs
} = require('../config');

/** Max characters from replied-to messages injected into the prompt (saves input tokens). */
const QUOTED_REPLY_CONTEXT_MAX_CHARS = 2000;

function userCooldownKey(userId, channelId) {
  return `${userId}:${channelId}`;
}

function ensureClientChatState(client) {
  if (!client.channelLocks) client.channelLocks = new Map();
  if (!client.channelQueueDepth) client.channelQueueDepth = new Map();
  if (!client.userCooldowns) client.userCooldowns = new Map();
  if (!client.channelCooldowns) client.channelCooldowns = new Map();
  if (!client.channelLastActivity) client.channelLastActivity = new Map();
  if (!client.channelGuildIds) client.channelGuildIds = new Map();
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @returns {number}
 */
function getChannelQueueDepth(client, channelId) {
  return client.channelQueueDepth?.get(channelId) || 0;
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function enqueueChannelChat(client, channelId, fn) {
  ensureClientChatState(client);
  const pending = getChannelQueueDepth(client, channelId);
  const previousLock = client.channelLocks.get(channelId) || Promise.resolve();
  client.channelQueueDepth.set(channelId, pending + 1);

  const currentLock = previousLock
    .catch(() => undefined)
    .then(async () => {
      try {
        await fn();
      } finally {
        const cur = client.channelQueueDepth.get(channelId) || 1;
        client.channelQueueDepth.set(channelId, Math.max(0, cur - 1));
      }
    });

  client.channelLocks.set(channelId, currentLock.catch(() => undefined));
  await currentLock;
}

/**
 * @typedef {object} ChannelChatDelivery
 * @property {(content: string) => Promise<void>} sendUserCooldown
 * @property {(content: string) => Promise<void>} sendChannelCooldown
 * @property {() => Promise<unknown|null>} createThinkingPlaceholder
 * @property {(content: string, thinkingPlaceholder: unknown|null) => Promise<boolean>} sendPrimaryResponse
 * @property {(content: string) => Promise<boolean>} sendAdditionalChunk
 */

/**
 * Runs the shared per-channel chat flow used by @mentions and /chat.
 *
 * @param {object} options
 * @param {import('discord.js').Client} options.client
 * @param {string} options.channelId
 * @param {string|null} options.guildId
 * @param {string} options.userId
 * @param {string} options.userTag
 * @param {string} options.channelName
 * @param {string} options.userText
 * @param {'mention'|'reply'|'slash'} options.trigger
 * @param {string} [options.messageId]
 * @param {Array} [options.replyChain]
 * @param {boolean} [options.isReplyToBot]
 * @param {import('discord.js').Message|null} [options.botReferencedMessage]
 * @param {Array} [options.extraImageAttachments]
 * @param {number} options.startedAt
 * @param {number} options.queueDepth
 * @param {ChannelChatDelivery} options.delivery
 * @param {string} [options.errorSource]
 * @returns {Promise<void>}
 */
async function runChannelChat({
  client,
  channelId,
  guildId,
  userId,
  userTag,
  channelName,
  userText,
  trigger,
  messageId = null,
  replyChain = [],
  isReplyToBot = false,
  botReferencedMessage = null,
  extraImageAttachments = [],
  startedAt,
  queueDepth,
  delivery,
  errorSource = 'channelChatHandler'
}) {
  const now = Date.now();
  const cooldownKey = userCooldownKey(userId, channelId);
  const lastUser = client.userCooldowns.get(cooldownKey) || 0;
  if (userCooldownMs > 0 && now - lastUser < userCooldownMs) {
    const waitMs = userCooldownMs - (now - lastUser);
    try {
      await delivery.sendUserCooldown(
        `Please wait ${Math.ceil(waitMs / 1000)}s before asking again in this channel.`
      );
    } catch (err) {
      logger.warn('Failed to send user cooldown reply.', {
        userId,
        channelId,
        trigger,
        ...serializeError(err)
      });
    }
    return;
  }

  const lastChannel = client.channelCooldowns.get(channelId) || 0;
  if (channelCooldownMs > 0 && now - lastChannel < channelCooldownMs) {
    const waitMs = channelCooldownMs - (now - lastChannel);
    try {
      await delivery.sendChannelCooldown(
        `Give me ${Math.ceil(waitMs / 1000)}s, then try again.`
      );
    } catch (err) {
      logger.warn('Failed to send channel cooldown reply.', {
        channelId,
        trigger,
        ...serializeError(err)
      });
    }
    return;
  }

  let thinkingPlaceholder = null;
  try {
    thinkingPlaceholder = await delivery.createThinkingPlaceholder();
  } catch (err) {
    logger.warn('Failed to send thinking placeholder.', {
      channelId,
      messageId,
      trigger,
      ...serializeError(err)
    });
  }

  logger.info('Chat request received.', {
    user: userTag,
    userId,
    guildId: guildId || null,
    channelId,
    channelName,
    messageId,
    contentLength: userText?.length || 0,
    imageCount: extraImageAttachments.length,
    replyChainLength: replyChain.length,
    isReplyToBot,
    trigger,
    provider: aiProvider,
    model: modelName,
    queueDepth
  });
  recordCount('discord.message.received', 1, {
    provider: aiProvider,
    trigger
  });
  recordGauge('discord.channel.queue_depth', queueDepth, {
    provider: aiProvider
  });

  client.channelLastActivity.set(channelId, Date.now());
  client.channelGuildIds.set(channelId, guildId ?? null);
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
    const systemMessage = createSystemMessage(modelName, aiProvider === 'openai');
    client.conversationHistory.set(channelId, [systemMessage]);
    logger.info('Created new conversation history for channel.', {
      channelId,
      guildId: guildId || null,
      messageId,
      historyLength: 1
    });
  }

  const channelHistory = client.conversationHistory.get(channelId);
  logger.debug('Loaded conversation history for channel.', {
    channelId,
    messageId,
    historyLength: channelHistory.length,
    trigger
  });

  const quotedTextParts = [];
  for (let i = 0; i < replyChain.length - 1; i++) {
    const msg = replyChain[i];
    if (msg.author?.id === client.user.id) continue;
    const text = (msg.content || '').trim();
    if (text) quotedTextParts.push(`${msg.author.username}: ${text}`);
  }

  let resolvedUserText = userText || '';
  if (quotedTextParts.length > 0) {
    let quotedBlock = quotedTextParts.join('\n');
    if (quotedBlock.length > QUOTED_REPLY_CONTEXT_MAX_CHARS) {
      quotedBlock = `${quotedBlock.slice(0, QUOTED_REPLY_CONTEXT_MAX_CHARS).trimEnd()}\n[truncated]`;
    }
    resolvedUserText = resolvedUserText
      ? `[Previous conversation:\n${quotedBlock}]\n\n${resolvedUserText}`
      : `[Previous conversation:\n${quotedBlock}]`;
  }

  const {
    attachments: chainAttachments,
    truncated: replyChainImagesTruncated,
    attachmentSources,
    embedSources
  } = collectReplyChainMedia(replyChain, client.user.id, { maxImages: maxReplyChainImages });

  const combinedAttachments = [...chainAttachments];
  for (const attachment of extraImageAttachments) {
    if (combinedAttachments.length >= maxReplyChainImages) break;
    combinedAttachments.push(attachment);
  }

  let imageContents = [];
  if (combinedAttachments.length > 0) {
    imageContents = await processImageAttachments(combinedAttachments);
    logger.info('Processed chat images.', {
      channelId,
      messageId,
      processedCount: imageContents.length,
      imageCount: combinedAttachments.length,
      attachmentSources,
      embedSources,
      truncated: replyChainImagesTruncated,
      trigger
    });
  }

  if (isReplyToBot && botReferencedMessage) {
    const lastAssistant = [...channelHistory].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant || lastAssistant.content !== botReferencedMessage.content) {
      channelHistory.push({
        role: 'assistant',
        content: botReferencedMessage.content
      });
    }
  }

  const userTurnIndex = channelHistory.length;
  const messageContent = createMessageContent(resolvedUserText, imageContents);
  let finalMessageContent = messageContent;
  if (imageContents.length > 0 && (!resolvedUserText || resolvedUserText.trim() === '')) {
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
  logger.debug('Updated conversation history for channel.', {
    channelId,
    messageId,
    historyLength: channelHistory.length,
    trigger
  });

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
  const aiStartedAt = Date.now();

  try {
    logger.info('Generating AI response.', {
      channelId,
      messageId,
      userId,
      provider: aiProvider,
      model: modelName,
      historyLength: channelHistory.length,
      imageCount: imageContents.length,
      trigger
    });
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
      const durationMs = Date.now() - aiStartedAt;
      logger.warn('No reply generated from AI service.', {
        channelId,
        messageId,
        provider: aiProvider,
        model: modelName,
        durationMs,
        outcome: 'empty',
        trigger
      });
      rollbackUserTurn();
      recordCount('discord.message.responded', 1, {
        provider: aiProvider,
        outcome: 'empty'
      });
      await delivery.sendPrimaryResponse(
        formatAIUserMessage({ reason: 'unknown', provider: aiProvider }),
        thinkingPlaceholder
      );
      applyCooldownStamps();
      return;
    }

    const replyIsError = isAIUserErrorMessage(reply);
    const durationMs = Date.now() - aiStartedAt;
    logger.info('Sending AI response.', {
      channelId,
      messageId,
      provider: aiProvider,
      model: modelName,
      responseCharCount: reply.length,
      durationMs,
      outcome: replyIsError ? 'error' : 'success',
      trigger
    });

    const messageChunks = splitMessage(reply);
    const deliveredChunks = [];
    let deliveryFailed = false;

    if (messageChunks.length === 0) {
      const fallback = formatAIUserMessage({ reason: 'empty_response', provider: aiProvider });
      if (await delivery.sendPrimaryResponse(fallback, thinkingPlaceholder)) {
        deliveredChunks.push(fallback);
      } else {
        deliveryFailed = true;
      }
    } else if (messageChunks.length === 1) {
      if (await delivery.sendPrimaryResponse(messageChunks[0], thinkingPlaceholder)) {
        deliveredChunks.push(messageChunks[0]);
      } else {
        deliveryFailed = true;
      }
    } else {
      if (await delivery.sendPrimaryResponse(messageChunks[0], thinkingPlaceholder)) {
        deliveredChunks.push(messageChunks[0]);

        for (let i = 1; i < messageChunks.length; i++) {
          if (await delivery.sendAdditionalChunk(messageChunks[i])) {
            deliveredChunks.push(messageChunks[i]);
          } else {
            deliveryFailed = true;
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

    if (!replyIsError && deliveredContent) {
      channelHistory.push({
        role: 'assistant',
        content: deliveredContent
      });
    }

    if (deliveryFailed && deliveredChunks.length === 0) {
      logger.warn('Failed to deliver AI response.', {
        user: userTag,
        channelId,
        channelName,
        messageId,
        chunkCount: messageChunks.length,
        outcome: 'delivery_failed',
        trigger
      });
      recordCount('discord.message.responded', 1, {
        provider: aiProvider,
        outcome: 'delivery_failed'
      });
    } else if (!fullyDelivered && deliveredChunks.length > 0) {
      logger.warn('Partially delivered AI response.', {
        user: userTag,
        channelId,
        channelName,
        messageId,
        deliveredChunks: deliveredChunks.length,
        totalChunks: messageChunks.length,
        outcome: replyIsError ? 'error' : 'partial',
        trigger
      });
      recordCount('discord.message.responded', 1, {
        provider: aiProvider,
        outcome: replyIsError ? 'error' : 'partial'
      });
    } else {
      logger.info('Reply sent successfully.', {
        user: userTag,
        channelId,
        channelName,
        messageId,
        responseCharCount: deliveredContent.length,
        chunkCount: messageChunks.length,
        durationMs: Date.now() - startedAt,
        outcome: replyIsError ? 'error' : 'success',
        trigger
      });
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
          trigger,
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
    captureError(error, { source: errorSource, handler: 'runChannelChat', trigger });
    recordCount('discord.message.responded', 1, {
      provider: aiProvider,
      outcome: 'error'
    });
    logger.error('Error occurred while processing chat request.', {
      userId,
      channelId,
      messageId,
      guildId: guildId || null,
      provider: aiProvider,
      model: modelName,
      trigger,
      ...serializeError(error, { includeStack: true })
    });

    await delivery.sendPrimaryResponse(
      formatAIUserMessage({ error, provider: aiProvider }),
      thinkingPlaceholder
    );
    if (aiWasInvoked) {
      applyCooldownStamps();
    }
  } finally {
    stripImagesFromHistory(channelHistory);
    const durationMs = Date.now() - startedAt;
    recordDistribution('discord.message.processing_ms', durationMs, {
      unit: 'millisecond',
      attributes: {
        provider: aiProvider,
        trigger
      }
    });
    logger.info('Finished processing chat request.', {
      channelId,
      messageId,
      guildId: guildId || null,
      provider: aiProvider,
      trigger,
      durationMs
    });
  }
}

module.exports = {
  QUOTED_REPLY_CONTEXT_MAX_CHARS,
  userCooldownKey,
  ensureClientChatState,
  getChannelQueueDepth,
  enqueueChannelChat,
  runChannelChat,
  maxPendingPerChannel
};
