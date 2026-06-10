const { Events } = require('discord.js');
const path = require('path');
const logger = require('../logger')(path.basename(__filename));

/**
 * When a message is deleted, drop the last assistant turn if it likely matches the deleted bot reply.
 * User turns are not matched by ID (history does not store Discord message IDs).
 * @module events/messageDelete
 */
module.exports = {
  name: Events.MessageDelete,
  /**
   * @param {import('discord.js').Message|import('discord.js').PartialMessage} message
   * @returns {Promise<void>}
   */
  async execute(message) {
    const client = message.client;
    if (!client.discordReady || !client.user?.id) return;
    if (!message.channelId || !client.conversationHistory?.has(message.channelId)) return;

    const channelHistory = client.conversationHistory.get(message.channelId);
    if (!Array.isArray(channelHistory) || channelHistory.length < 2) return;

    const deletedAuthorId = message.author?.id;
    const deletedContent = (message.content || '').trim();
    if (!deletedAuthorId || deletedAuthorId !== client.user.id || !deletedContent) return;

    const last = channelHistory[channelHistory.length - 1];
    if (last?.role !== 'assistant') return;

    const stored = typeof last.content === 'string' ? last.content.trim() : '';
    if (!stored) return;

    if (stored === deletedContent || stored.startsWith(deletedContent) || deletedContent.startsWith(stored)) {
      channelHistory.pop();
      logger.debug('Removed deleted bot reply from conversation history.', {
        channelId: message.channelId,
        messageId: message.id
      });
    }
  }
};
