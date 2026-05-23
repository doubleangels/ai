const path = require('path');
const logger = require('../logger')(path.basename(__filename));
const https = require('https');
const { URL } = require('url');
const { imageDownloadTimeoutMs, maxImageBytes, maxOutputTokens } = require('../config');

/** Only these hosts may be fetched (including redirects) — mitigates SSRF via malicious redirects from attachment URLs. */
const DISCORD_IMAGE_CDN_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net'
]);

/**
 * @param {string} urlString
 * @returns {URL}
 */
function assertDiscordImageDownloadUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid image URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Image download must use HTTPS.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!DISCORD_IMAGE_CDN_HOSTS.has(host)) {
    throw new Error('Image download is restricted to Discord CDN URLs.');
  }
  return parsed;
}

/** Rough vision-token budget per attached image for history trimming (text-only estimates are insufficient). */
const ESTIMATED_TOKENS_PER_IMAGE = 768;

/**
 * Rough max reply length hint for the model (Discord sends ~2000 chars per message; align with MAX_OUTPUT_TOKENS).
 * @returns {number} Character budget for FORMAT_RULES
 */
function getApproxMaxReplyChars() {
  const max = typeof maxOutputTokens === 'number' && maxOutputTokens > 0 ? maxOutputTokens : 1024;
  return Math.min(1900, Math.max(600, Math.floor(max * 2.5)));
}

/**
 * Shared format rules for all providers: no titles, same general structure.
 */
function getFormatRules() {
  const charCap = getApproxMaxReplyChars();
  return (
    'Do not start with a title or ## header; reply directly in a consistent, plain format. ' +
    `Keep every reply under ${charCap} characters (Discord message limit is ~2000), stay focused on the user's goal, and avoid filler. ` +
    'Prefer a direct answer first; this is a fast chat channel. Use Discord markdown sparingly for clarity: **bold** for key terms, *italics* for subtle emphasis, ' +
    'bullet lists or numbered steps only when they organize information, `inline code` for identifiers, and fenced code blocks for longer snippets. ' +
    "If the user's request is ambiguous, ask one clarifying question before proceeding. " +
    'Always provide actionable, trustworthy information tailored to the conversation context.'
  );
}

/**
 * System message constants. BASE includes the model name (for OpenAI); BASE_GENERIC does not (for Gemini/Claude).
 * All providers use the same format rules (no titles, same structure).
 */
const SYSTEM_MESSAGES = {
  BASE: (modelName) => `You are an AI assistant running inside a Discord bot and powered by the ${modelName} model. You can analyze both text and images—describe only the details relevant to the user's request. ${getFormatRules()}`,
  BASE_GENERIC: `You are an AI assistant running inside a Discord bot. You can analyze both text and images—describe only the details relevant to the user's request. ${getFormatRules()}`,
  IMAGE_ANALYSIS: "When analyzing images, focus on the elements that answer the user's question. Keep the description short, factual, and relevant; avoid ornamental details. Do not use titles or headers.",
  IMAGE_DESCRIPTION_PROMPT: "Give a brief description of this image, highlighting only the key elements."
};

/**
 * Configuration for message splitting functionality
 * @type {Object}
 */
const MESSAGE_CONFIG = {
  defaultLimit: 2000,
  errorMessage: 'Error splitting message'
};

/**
 * Splits a message into chunks that fit within Discord's message length limit.
 * Attempts to split at intelligent break points: paragraphs, sentences, then words.
 * 
 * @param {string} text - The text to split into chunks
 * @param {number} [limit=2000] - Maximum length for each chunk
 * @returns {string[]} Array of message chunks
 */
function splitMessage(text, limit = 2000) {
  try {
    if (!text) {
      logger.debug('Empty text provided to splitMessage, returning empty array.');
      return [];
    }
    
    if (text.length <= limit) {
      logger.debug('Text length is within limit, no splitting needed.');
      return [text];
    }
    
    logger.debug(`Splitting message of ${text.length} characters into chunks of max ${limit} characters.`);
    
    const chunks = [];
    let remainingText = text;
    
    while (remainingText.length > limit) {
      let splitPoint = findBestSplitPoint(remainingText, limit);
      
      const chunk = remainingText.substring(0, splitPoint).trim();
      chunks.push(chunk);

      remainingText = remainingText.substring(splitPoint);
      
      remainingText = remainingText.replace(/^[\s\n\r]+/, '');
      
      logger.debug(`Chunk ${chunks.length} created with ${chunk.length} characters.`);
    }
    
    if (remainingText.length > 0) {
      const finalChunk = remainingText.trim();
      if (finalChunk.length > 0) {
        chunks.push(finalChunk);
        logger.debug(`Final chunk ${chunks.length} created with ${finalChunk.length} characters.`);
      }
    }
    
    logger.debug(`Message split into ${chunks.length} chunks.`, {
      originalLength: text.length,
      chunkCount: chunks.length,
      chunkSizes: chunks.map(chunk => chunk.length),
      averageChunkSize: Math.round(text.length / chunks.length)
    });
    
    return chunks;
  } catch (error) {
    logger.error('Error in splitMessage function.', { 
      error: error.stack,
      message: error.message,
      textLength: text?.length
    });
    return ['Error splitting message'];
  }
}

/**
 * Finds the best split point within the given limit, prioritizing:
 * 1. Double newlines (paragraph breaks)
 * 2. Single newlines
 * 3. Sentence endings (.!?)
 * 4. Word boundaries
 * 5. Fallback to character limit
 * 
 * @param {string} text - The text to find a split point in
 * @param {number} limit - Maximum length for the chunk
 * @returns {number} The best split point index
 */
function findBestSplitPoint(text, limit) {
  const paragraphBreak = findLastOccurrence(text, '\n\n', limit);
  if (paragraphBreak > limit * 0.7) {
    return paragraphBreak + 2;
  }
  
  const newlineBreak = findLastOccurrence(text, '\n', limit);
  if (newlineBreak > limit * 0.8) {
    return newlineBreak + 1;
  }
  
  const sentenceEndings = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
  let bestSentenceBreak = -1;
  
  for (const ending of sentenceEndings) {
    const breakPoint = findLastOccurrence(text, ending, limit);
    if (breakPoint > bestSentenceBreak && breakPoint > limit * 0.6) {
      bestSentenceBreak = breakPoint + ending.length;
    }
  }
  
  if (bestSentenceBreak > 0) {
    return bestSentenceBreak;
  }
  
  const wordBreak = findLastOccurrence(text, ' ', limit);
  if (wordBreak > limit * 0.5) {
    return wordBreak + 1;
  }
  
  return limit;
}

/**
 * Finds the last occurrence of a substring before a given position
 * 
 * @param {string} text - The text to search in
 * @param {string} searchStr - The string to search for
 * @param {number} maxPos - Maximum position to search up to
 * @returns {number} The position of the last occurrence, or -1 if not found
 */
function findLastOccurrence(text, searchStr, maxPos) {
  const searchLength = searchStr.length;
  let lastPos = -1;
  let pos = 0;
  
  while (pos < maxPos) {
    const foundPos = text.indexOf(searchStr, pos);
    if (foundPos === -1 || foundPos >= maxPos) {
      break;
    }
    lastPos = foundPos;
    pos = foundPos + searchLength;
  }
  
  return lastPos;
}

/**
 * Downloads an image from a URL and converts it to base64.
 * 
 * @param {string} url - The URL of the image to download
 * @returns {Promise<string>} Base64 encoded image data with mime type
 */
async function downloadImageAsBase64(url) {
  const maxRedirects = 3;
  const timeoutMs = typeof imageDownloadTimeoutMs === 'number' && imageDownloadTimeoutMs > 0
    ? imageDownloadTimeoutMs
    : 8000;
  const maxBytes = typeof maxImageBytes === 'number' && maxImageBytes > 0
    ? maxImageBytes
    : 6_000_000;

  const download = (currentUrl, redirectsLeft) => new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = assertDiscordImageDownloadUrl(currentUrl);
    } catch (err) {
      reject(err);
      return;
    }

    const req = https.get(currentUrl, (response) => {
      const status = response.statusCode || 0;

      // Handle redirects.
      if (status >= 300 && status < 400 && response.headers.location) {
        if (redirectsLeft <= 0) {
          response.resume();
          reject(new Error('Too many redirects while downloading image.'));
          return;
        }
        let nextUrl;
        try {
          nextUrl = new URL(response.headers.location, parsed).toString();
          assertDiscordImageDownloadUrl(nextUrl);
        } catch (err) {
          response.resume();
          reject(err);
          return;
        }
        response.resume();
        resolve(download(nextUrl, redirectsLeft - 1));
        return;
      }

      if (status !== 200) {
        response.resume();
        reject(new Error(`Failed to download image: HTTP ${status}`));
        return;
      }

      const mimeType = (response.headers['content-type'] || '').toString();
      if (!mimeType.startsWith('image/')) {
        response.resume();
        reject(new Error(`Unsupported content-type for image download: ${mimeType || 'unknown'}`));
        return;
      }

      const contentLengthHeader = response.headers['content-length'];
      const contentLength = contentLengthHeader ? parseInt(String(contentLengthHeader), 10) : NaN;
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.resume();
        reject(new Error(`Image exceeds max size (${contentLength} > ${maxBytes} bytes).`));
        return;
      }

      const chunks = [];
      let total = 0;

      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(new Error(`Image exceeds max size (${maxBytes} bytes).`));
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        resolve(`data:${mimeType};base64,${base64}`);
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Image download timed out after ${timeoutMs}ms.`));
    });

    req.on('error', (error) => reject(error));
  });

  return download(url, maxRedirects);
}

/**
 * Creates a message content array that can include both text and images.
 * 
 * @param {string} text - The text content
 * @param {Array} imageContents - Array of image content objects
 * @returns {Array} Message content array for OpenAI API
 */
function createMessageContent(text, imageContents = []) {
  const content = [];
  
  if (text && text.trim()) {
    content.push({
      type: 'input_text',
      text: text.trim()
    });
  }
  
  content.push(...imageContents);
  
  return content;
}

/**
 * Processes Discord attachments and converts images to base64 format for OpenAI API.
 * 
 * @param {Array} attachments - Array of Discord message attachments
 * @returns {Promise<Array>} Array of processed image content objects
 */
async function processImageAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];

  const indexed = await Promise.all(
    list.map(async (attachment, index) => {
      const isImage = attachment.contentType && attachment.contentType.startsWith('image/');
      if (!isImage) return { index, item: null };

      const attachmentLabel = attachment.name || attachment.filename || attachment.url || 'unknown';
      try {
        logger.debug(`Processing image attachment: ${attachmentLabel} (${attachment.contentType})`);
        const base64Image = await downloadImageAsBase64(attachment.url);
        logger.debug(`Successfully processed image: ${attachmentLabel}`);
        return {
          index,
          item: {
            type: 'input_image',
            image_url: base64Image
          }
        };
      } catch (error) {
        logger.error(`Failed to process image attachment: ${attachmentLabel}`, {
          error: error.stack,
          message: error.message
        });
        return { index, item: null };
      }
    })
  );

  return indexed
    .filter(entry => entry.item)
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.item);
}



/**
 * Checks if a conversation contains images.
 * 
 * @param {Array<{role: string, content: string|Array}>} conversation - Array of conversation messages
 * @returns {boolean} True if the conversation contains images
 */
function hasImages(conversation) {
  return conversation.some(message => {
    if (Array.isArray(message.content)) {
      return message.content.some(item => item.type === 'input_image');
    }
    return false;
  });
}

function estimateTokensFromText(text) {
  if (!text) return 0;
  // Very rough heuristic: ~4 chars per token for English-ish text.
  return Math.ceil(String(text).length / 4);
}

function estimateMessageTokens(message) {
  if (!message) return 0;
  const content = message.content;
  if (typeof content === 'string') return estimateTokensFromText(content);
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const item of content) {
    if (item && item.type === 'input_text' && typeof item.text === 'string') {
      total += estimateTokensFromText(item.text);
    }
    if (item && item.type === 'input_image') {
      total += ESTIMATED_TOKENS_PER_IMAGE;
    }
  }
  return total;
}

/**
 * Trims conversation history to maintain maximum length while preserving system message.
 * Mutates channelHistory in place; callers must pass the array they want modified.
 *
 * @param {Array} channelHistory - The conversation history array (mutated in place)
 * @param {number} maxHistoryLength - Maximum number of messages to keep
 * @param {number} [maxHistoryTokens=0] - Rough token cap (0 disables token trimming)
 * @returns {Array} The same channelHistory array (trimmed)
 */
function trimConversationHistory(channelHistory, maxHistoryLength, maxHistoryTokens = 0) {
  if (!Array.isArray(channelHistory) || channelHistory.length === 0) return channelHistory;

  if (channelHistory.length > maxHistoryLength + 1) {
    logger.debug(`Trimming conversation history (current: ${channelHistory.length}, max: ${maxHistoryLength + 1}).`);
    const systemMessage = channelHistory[0];
    channelHistory.splice(1, channelHistory.length - maxHistoryLength - 1);
    channelHistory[0] = systemMessage;
  }

  if (typeof maxHistoryTokens === 'number' && maxHistoryTokens > 0) {
    let totalTokens = 0;
    for (const msg of channelHistory) totalTokens += estimateMessageTokens(msg);

    let removed = 0;
    while (channelHistory.length > 1 && totalTokens > maxHistoryTokens) {
      const removedMsg = channelHistory.splice(1, 1)[0];
      totalTokens -= estimateMessageTokens(removedMsg);
      removed += 1;
    }

    if (removed > 0) {
      logger.debug('Trimmed conversation by token estimate.', {
        removedMessages: removed,
        remainingMessages: channelHistory.length,
        estimatedTokens: totalTokens,
        maxHistoryTokens
      });
    }
  }

  return channelHistory;
}

/**
 * Removes stale entries from a Map keyed by id with timestamp values.
 * @param {Map<string|number, number>} map - Map of id → last-used timestamp
 * @param {number} maxAgeMs - Entries older than this are deleted
 */
function pruneStaleMapEntries(map, maxAgeMs) {
  if (!map || typeof maxAgeMs !== 'number' || maxAgeMs <= 0) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, timestamp] of map) {
    if (timestamp < cutoff) {
      map.delete(key);
    }
  }
}

/**
 * Replaces base64 image parts in prior user turns with a lightweight placeholder.
 * @param {Array} channelHistory - Conversation history array
 */
function stripImagesFromHistory(channelHistory) {
  if (!Array.isArray(channelHistory)) return;

  for (let idx = 0; idx < channelHistory.length - 1; idx++) {
    const historyMessage = channelHistory[idx];
    if (historyMessage.role === 'user' && Array.isArray(historyMessage.content)) {
      for (let j = 0; j < historyMessage.content.length; j++) {
        const part = historyMessage.content[j];
        if (part && part.type === 'input_image' && part.image_url) {
          historyMessage.content[j] = { type: 'input_text', text: '[Previous Image Processed]' };
        }
      }
    }
  }
}

/**
 * Creates a system message for conversation initialization.
 * Only OpenAI is told which model is running; Gemini and Claude get a generic prompt.
 *
 * @param {string} modelName - The AI model name (used only when includeModelInPrompt is true)
 * @param {boolean} [includeModelInPrompt=true] - If true, system message includes "powered by the X model"; if false, generic prompt only
 * @returns {Object} The system message object
 */
function createSystemMessage(modelName, includeModelInPrompt = true) {
  const content = includeModelInPrompt
    ? SYSTEM_MESSAGES.BASE(modelName)
    : SYSTEM_MESSAGES.BASE_GENERIC;
  return {
    role: 'system',
    content
  };
}

module.exports = {
  assertDiscordImageDownloadUrl,
  splitMessage,
  downloadImageAsBase64,
  createMessageContent,
  processImageAttachments,
  hasImages,
  estimateTokensFromText,
  trimConversationHistory,
  pruneStaleMapEntries,
  stripImagesFromHistory,
  createSystemMessage,
  SYSTEM_MESSAGES
};
