const path = require('path');
const logger = require('../logger')(path.basename(__filename));

/** Maximum depth for reply chain traversal (prevent infinite loops) */
const MAX_CHAIN_DEPTH = 50;

/** Cache for fetched messages to avoid duplicate API calls */
const MESSAGE_CACHE = new Map();

/**
 * Clear the message cache (useful for testing or manual cache clearing)
 */
function clearCache() {
  MESSAGE_CACHE.clear();
}

/**
 * Fetch a message with caching
 * @param {Channel} channel - Discord channel object
 * @param {string} messageId - Message ID to fetch
 * @returns {Promise<Message|null>} The message or null if fetch fails
 */
async function fetchMessageCached(channel, messageId) {
  const cacheKey = `${channel.id}:${messageId}`;
  
  // Return from cache if available
  if (MESSAGE_CACHE.has(cacheKey)) {
    return MESSAGE_CACHE.get(cacheKey);
  }

  try {
    const message = await channel.messages.fetch(messageId);
    MESSAGE_CACHE.set(cacheKey, message);
    return message;
  } catch (error) {
    logger.debug('Failed to fetch message for chain traversal', {
      channelId: channel.id,
      messageId,
      error: error.message
    });
    return null;
  }
}

/**
 * Trace a reply chain backwards to find all messages in the conversation
 * Follows message.reference → fetches parent → repeats until reaching the start
 * 
 * @param {Message} startMessage - The Discord message to start tracing from
 * @param {Channel} channel - The Discord channel
 * @returns {Promise<Array<Message>>} Array of messages from oldest to newest (including startMessage)
 */
async function traceReplyChain(startMessage, channel) {
  const chain = [];
  let currentMessage = startMessage;
  let depth = 0;

  try {
    // Traverse backwards through the reply chain
    while (currentMessage && depth < MAX_CHAIN_DEPTH) {
      // Add current message to the beginning (we'll reverse at the end)
      chain.unshift(currentMessage);

      // Check if there's a parent message to fetch
      if (!currentMessage.reference || !currentMessage.reference.messageId) {
        // No parent - we've reached the start of the chain
        break;
      }

      // Fetch the parent message
      const parentMessage = await fetchMessageCached(channel, currentMessage.reference.messageId);
      
      if (!parentMessage) {
        // Can't fetch parent, stop here
        logger.debug('Could not fetch parent message, stopping chain traversal', {
          channelId: channel.id,
          messageId: currentMessage.reference.messageId,
          chainDepth: depth
        });
        break;
      }

      currentMessage = parentMessage;
      depth++;
    }

    if (depth >= MAX_CHAIN_DEPTH) {
      logger.warn('Reply chain depth limit reached', {
        channelId: channel.id,
        depth: MAX_CHAIN_DEPTH
      });
    }

    logger.debug('Reply chain traced', {
      channelId: channel.id,
      chainLength: chain.length,
      depth
    });

    return chain;
  } catch (error) {
    logger.error('Error tracing reply chain', {
      error: error.message,
      channelId: channel.id,
      chainLength: chain.length
    });
    // Return what we have so far
    return chain.length > 0 ? chain : [startMessage];
  }
}

/**
 * Extract conversation context from a reply chain
 * Formats messages as a readable conversation string
 * 
 * @param {Array<Message>} chain - Array of messages in the reply chain
 * @returns {string} Formatted conversation context
 */
function formatChainAsContext(chain) {
  if (!chain || chain.length === 0) {
    return '';
  }

  if (chain.length === 1) {
    // Single message, no context needed
    return '';
  }

  const contextLines = [];
  contextLines.push('[Previous conversation context]');

  // Format each message in the chain (skip the last one - that's the current message)
  for (let i = 0; i < chain.length - 1; i++) {
    const msg = chain[i];
    const author = msg.author?.username || msg.author?.tag || 'Unknown';
    
    // Truncate long messages in context
    let content = msg.content || '';
    if (content.length > 200) {
      content = content.substring(0, 200) + '...';
    }
    
    // Clean up mentions in context
    content = content.replace(/<@!?\d+>/g, '@user');
    
    contextLines.push(`${author}: ${content}`);
  }

  contextLines.push('[End of context]');
  return contextLines.join('\n');
}

/**
 * Get all messages in the reply chain with their content and metadata
 * 
 * @param {Array<Message>} chain - Array of messages in the reply chain
 * @returns {Promise<Array<Object>>} Array of message objects with content and metadata
 */
async function extractChainMessages(chain) {
  const messages = [];

  for (const msg of chain) {
    const messageData = {
      id: msg.id,
      content: msg.content || '',
      author: {
        id: msg.author.id,
        username: msg.author.username,
        tag: msg.author.tag
      },
      timestamp: msg.createdTimestamp,
      attachments: msg.attachments.size,
      isBot: msg.author.bot
    };

    messages.push(messageData);
  }

  return messages;
}

module.exports = {
  traceReplyChain,
  formatChainAsContext,
  extractChainMessages,
  fetchMessageCached,
  clearCache,
  MAX_CHAIN_DEPTH
};
