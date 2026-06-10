const path = require('path');
const logger = require('../logger')(path.basename(__filename));
const { safeAttachmentLabel, serializeError } = require('./logSanitize');
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
  return Math.min(800, Math.max(200, Math.floor(max * 0.8)));
}

/**
 * Shared format rules for all providers: TLDR-first, no titles.
 */
function getFormatRules() {
  const charCap = getApproxMaxReplyChars();
  return (
    'Default to TLDR: lead with the answer in 1–3 short sentences, or a few tight bullets when listing distinct items. ' +
    'No preamble (e.g. "Sure!", "Here\'s…") or closing filler. ' +
    `Stay under ${charCap} characters unless the user asks for detail or you must show code/steps. ` +
    'Do not start with a title or ## header. Use markdown sparingly: **bold** for at most one key term, `inline code` for identifiers, ' +
    'lists only when there are 3+ separate points, and fenced code blocks only for code or multi-step fixes. ' +
    "If the request is ambiguous, ask one short clarifying question. Expand only when the user wants more depth or the task requires it."
  );
}

/**
 * System message constants. BASE includes the model name (for OpenAI); BASE_GENERIC does not (for Gemini/Claude).
 * All providers use the same format rules (no titles, same structure).
 */
const SYSTEM_MESSAGES = {
  BASE: (modelName) => `You are an AI assistant running inside a Discord bot and powered by the ${modelName} model. You can analyze both text and images—describe only the details relevant to the user's request. ${getFormatRules()}`,
  BASE_GENERIC: `You are an AI assistant running inside a Discord bot. You can analyze both text and images—describe only the details relevant to the user's request. ${getFormatRules()}`,
  IMAGE_ANALYSIS: "When analyzing images, give a one-sentence TLDR of what matters for the user's question—factual, no filler, no titles.",
  IMAGE_DESCRIPTION_PROMPT: 'TLDR this image in 1–2 sentences; only what is essential.'
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
function splitMessage(text, limit = MESSAGE_CONFIG.defaultLimit) {
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
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

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
      textLength: text?.length,
      ...serializeError(error, { includeStack: true })
    });
    return [MESSAGE_CONFIG.errorMessage];
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
 * Normalizes a Discord attachment or embed pseudo-attachment URL for deduplication.
 * @param {{ url?: string, proxyURL?: string, proxyUrl?: string }} item
 * @returns {string|undefined}
 */
function normalizeMediaUrl(item) {
  if (!item) return undefined;
  return item.proxyURL || item.proxyUrl || item.url;
}

/**
 * Infers image MIME type from a Discord CDN URL path.
 * @param {string} url
 * @returns {string}
 */
function inferImageContentTypeFromUrl(url) {
  const lower = String(url).toLowerCase();
  if (lower.includes('.gif')) return 'image/gif';
  if (lower.includes('.webp')) return 'image/webp';
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.jpg') || lower.includes('.jpeg')) return 'image/jpeg';
  return 'image/png';
}

/**
 * Returns true when a MIME type is a supported raster image for vision (excludes SVG).
 * @param {string|undefined} contentType
 * @returns {boolean}
 */
function isSupportedVisionImageType(contentType) {
  if (!contentType || typeof contentType !== 'string') return false;
  const normalized = contentType.toLowerCase().trim();
  if (!normalized.startsWith('image/')) return false;
  if (normalized.includes('svg')) return false;
  return true;
}

/**
 * Returns true when a URL is allowed for vision download (Discord CDN, HTTPS).
 * @param {string} url
 * @returns {boolean}
 */
function isAllowedDiscordImageUrl(url) {
  try {
    assertDiscordImageDownloadUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collects image/GIF attachment and embed preview URLs from a reply chain (oldest first).
 * @param {Array} replyChain - Discord messages oldest → newest
 * @param {string} botId - Bot user id; bot messages are skipped
 * @param {{ maxImages?: number }} [options]
 * @returns {{ attachments: Array, truncated: boolean, attachmentSources: number, embedSources: number }}
 */
function collectReplyChainMedia(replyChain, botId, options = {}) {
  const maxImages = typeof options.maxImages === 'number' && options.maxImages > 0
    ? options.maxImages
    : 4;
  const chain = Array.isArray(replyChain) ? replyChain : [];
  const seen = new Set();
  const attachments = [];
  let truncated = false;
  let attachmentSources = 0;
  let embedSources = 0;

  const pushCandidate = (item) => {
    const url = normalizeMediaUrl(item);
    if (!url || seen.has(url) || !isAllowedDiscordImageUrl(url)) return false;
    if (attachments.length >= maxImages) {
      truncated = true;
      return false;
    }
    seen.add(url);
    attachments.push(item);
    return true;
  };

  for (const msg of chain) {
    if (!msg || msg.author?.id === botId) continue;

    if (msg.attachments && msg.attachments.size > 0) {
      const values = typeof msg.attachments.values === 'function'
        ? Array.from(msg.attachments.values())
        : [];
      for (const att of values) {
        if (!isSupportedVisionImageType(att?.contentType)) continue;
        if (pushCandidate(att)) attachmentSources += 1;
        if (truncated) break;
      }
    }
    if (truncated) break;

    const embeds = Array.isArray(msg.embeds) ? msg.embeds : [];
    for (const embed of embeds) {
      const urls = [];
      if (embed?.image?.url) urls.push(embed.image.url);
      if (embed?.thumbnail?.url) urls.push(embed.thumbnail.url);

      for (const url of urls) {
        if (pushCandidate({ url, contentType: inferImageContentTypeFromUrl(url) })) {
          embedSources += 1;
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  if (truncated) {
    logger.debug('Reply-chain image collection truncated.', {
      maxImages,
      collected: attachments.length
    });
  }

  return { attachments, truncated, attachmentSources, embedSources };
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
      if (!isSupportedVisionImageType(attachment.contentType)) return { index, item: null };

      const attachmentLabel = safeAttachmentLabel(attachment);
      const startedAt = Date.now();
      try {
        logger.debug('Processing image attachment.', {
          label: attachmentLabel,
          contentType: attachment.contentType
        });
        const mediaUrl = normalizeMediaUrl(attachment);
        if (!mediaUrl) {
          return { index, item: null };
        }
        const base64Image = await downloadImageAsBase64(mediaUrl);
        logger.debug('Successfully processed image attachment.', {
          label: attachmentLabel,
          contentType: attachment.contentType,
          durationMs: Date.now() - startedAt
        });
        return {
          index,
          item: {
            type: 'input_image',
            image_url: base64Image
          }
        };
      } catch (error) {
        logger.error('Failed to process image attachment.', {
          label: attachmentLabel,
          contentType: attachment.contentType,
          durationMs: Date.now() - startedAt,
          ...serializeError(error, { includeStack: true })
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

function getMessageTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(item => item && item.type === 'input_text' && typeof item.text === 'string')
      .map(item => item.text)
      .join('\n');
  }
  return '';
}

function mergeMessageContent(existing, incoming) {
  if (typeof existing === 'string' && typeof incoming === 'string') {
    return `${existing}\n\n${incoming}`.trim();
  }
  const parts = Array.isArray(existing) ? [...existing] : [{ type: 'input_text', text: String(existing || '') }];
  const incomingText = getMessageTextContent(incoming);
  if (incomingText) {
    const textPart = parts.find(item => item && item.type === 'input_text');
    if (textPart) {
      textPart.text = `${textPart.text}\n\n${incomingText}`.trim();
    } else {
      parts.unshift({ type: 'input_text', text: incomingText });
    }
  }
  if (Array.isArray(incoming)) {
    for (const item of incoming) {
      if (item && item.type === 'input_image') {
        parts.push(item);
      }
    }
  }
  return parts;
}

/**
 * Merges consecutive user turns so provider APIs receive alternating roles.
 * @param {Array} channelHistory
 * @returns {Array}
 */
function normalizeConversationRoles(channelHistory) {
  if (!Array.isArray(channelHistory) || channelHistory.length <= 1) {
    return channelHistory;
  }

  const hasSystem = channelHistory[0]?.role === 'system';
  const rest = hasSystem ? channelHistory.slice(1) : [...channelHistory];
  const normalized = hasSystem ? [channelHistory[0]] : [];

  for (const msg of rest) {
    if (!msg || !msg.role) continue;
    normalized.push({ role: msg.role, content: msg.content });
  }

  const startIndex = hasSystem ? 1 : 0;
  while (normalized.length > startIndex + 1) {
    const last = normalized[normalized.length - 1];
    const prev = normalized[normalized.length - 2];
    if (last.role === 'user' && prev.role === 'user') {
      prev.content = mergeMessageContent(prev.content, last.content);
      normalized.pop();
    } else {
      break;
    }
  }

  channelHistory.splice(0, channelHistory.length, ...normalized);
  return channelHistory;
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
    logger.debug('Trimming conversation history.', { current: channelHistory.length, max: maxHistoryLength + 1 });
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
 * Removes per-channel lock/queue entries when no work is pending for that channel.
 * @param {string} channelId
 * @param {Map<string, Promise>|undefined} channelLocks
 * @param {Map<string, number>|undefined} channelQueueDepth
 */
function pruneChannelAuxMaps(channelId, channelLocks, channelQueueDepth, channelGuildIds) {
  if (!channelId) return;
  const depth = channelQueueDepth?.get(channelId) || 0;
  if (depth > 0) return;
  channelQueueDepth?.delete(channelId);
  channelLocks?.delete(channelId);
  channelGuildIds?.delete(channelId);
}

/**
 * Prunes idle channel histories and enforces a max channel count (LRU by last activity).
 * Optionally prunes channelLocks and channelQueueDepth for evicted channels.
 * @param {Map<string, Array>} conversationHistory
 * @param {Map<string, number>} channelLastActivity - channelId → last activity timestamp
 * @param {number} maxChannels - Max channels to retain (0 = no cap)
 * @param {number} idleMs - Drop histories idle longer than this (0 = disabled)
 * @param {Map<string, Promise>} [channelLocks]
 * @param {Map<string, number>} [channelQueueDepth]
 * @param {Map<string, string|null>} [channelGuildIds]
 */
function pruneConversationHistories(
  conversationHistory,
  channelLastActivity,
  maxChannels,
  idleMs,
  channelLocks,
  channelQueueDepth,
  channelGuildIds
) {
  if (!conversationHistory) return;

  const evictChannel = (channelId) => {
    conversationHistory.delete(channelId);
    channelLastActivity?.delete(channelId);
    pruneChannelAuxMaps(channelId, channelLocks, channelQueueDepth, channelGuildIds);
  };

  const now = Date.now();
  if (typeof idleMs === 'number' && idleMs > 0 && channelLastActivity) {
    for (const channelId of [...conversationHistory.keys()]) {
      const lastActive = channelLastActivity.get(channelId) ?? 0;
      if (now - lastActive > idleMs) {
        evictChannel(channelId);
      }
    }
  }

  if (typeof maxChannels !== 'number' || maxChannels <= 0 || !channelLastActivity) return;

  while (conversationHistory.size > maxChannels) {
    let oldestChannelId = null;
    let oldestActivity = Infinity;
    for (const channelId of conversationHistory.keys()) {
      const lastActive = channelLastActivity.get(channelId) ?? 0;
      if (lastActive < oldestActivity) {
        oldestActivity = lastActive;
        oldestChannelId = channelId;
      }
    }
    if (!oldestChannelId) break;
    evictChannel(oldestChannelId);
  }
}

/**
 * Replaces base64 image parts in prior user turns with a lightweight placeholder.
 * @param {Array} channelHistory - Conversation history array
 */
function stripImagesFromHistory(channelHistory) {
  if (!Array.isArray(channelHistory)) return;

  const lastRole = channelHistory[channelHistory.length - 1]?.role;
  const lastUserIndex = lastRole === 'assistant'
    ? channelHistory.length - 2
    : channelHistory.length - 1;

  for (let idx = 0; idx <= lastUserIndex && idx < channelHistory.length; idx++) {
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

/** @typedef {'rate_limit'|'quota_exceeded'|'timeout'|'auth'|'permission_denied'|'billing'|'content_filter'|'context_length'|'missing_api_key'|'empty_response'|'not_found'|'invalid_request'|'overloaded'|'api_error'|'unknown'} AIErrorReason */

/** @typedef {'openai'|'claude'|'gemini'} AIProviderName */

const DEFAULT_ERROR_MESSAGES = {
  rate_limit: 'The AI service is busy. Please wait a moment and try again.',
  quota_exceeded: 'The AI usage quota was exceeded. Contact the bot owner to check billing.',
  timeout: 'The request timed out. Please try again.',
  auth: 'The AI service rejected the request (authentication). Contact the bot owner.',
  permission_denied: 'The AI service denied access. Contact the bot owner.',
  billing: 'There is a billing issue with the AI provider. Contact the bot owner.',
  content_filter: "Your message couldn't be processed due to content restrictions.",
  context_length: 'The conversation is too long. Try `/reset` or a shorter message.',
  missing_api_key: "The AI provider isn't configured on this bot.",
  empty_response: 'The model returned an empty response. Please try again.',
  not_found: 'The requested AI model or resource was not found. Contact the bot owner.',
  invalid_request: 'The AI service rejected the request format. Please try again or rephrase.',
  overloaded: 'The AI service is temporarily overloaded. Please try again shortly.',
  api_error: 'The AI service returned an error. Please try again.',
  unknown: 'Something went wrong while generating a response. Please try again.'
};

/** Provider-specific user messages keyed by classified reason. */
const PROVIDER_ERROR_MESSAGES = {
  openai: {
    rate_limit: 'OpenAI rate limit reached (429). Please wait a moment and try again.',
    quota_exceeded: 'OpenAI quota exceeded (429). Contact the bot owner to check billing and usage limits.',
    timeout: 'OpenAI request timed out. Please try again.',
    auth: 'OpenAI authentication failed (401). Contact the bot owner to verify the API key.',
    permission_denied: 'OpenAI denied access (403). This may be a permissions or region restriction.',
    content_filter: "OpenAI blocked the response due to content policy.",
    context_length: 'OpenAI context limit exceeded. Try `/reset` or send a shorter message.',
    not_found: 'OpenAI could not find the model or resource (404). Contact the bot owner.',
    invalid_request: 'OpenAI rejected the request (400). Please try again or rephrase.',
    overloaded: 'OpenAI is overloaded (503). Please try again shortly.',
    api_error: 'OpenAI returned a server error (5xx). Please try again.',
    missing_api_key: "OpenAI isn't configured on this bot (missing OPENAI_API_KEY).",
    empty_response: 'OpenAI returned an empty response. Please try again.',
    unknown: 'Something went wrong with OpenAI. Please try again.'
  },
  claude: {
    rate_limit: 'Claude rate limit reached (429). Please wait and try again.',
    quota_exceeded: 'Claude rate or token limit reached (429). Please wait and try again.',
    timeout: 'Claude request timed out (504). Please try again or use a shorter prompt.',
    auth: 'Claude authentication failed (401). Contact the bot owner to verify the API key.',
    permission_denied: 'Claude permission denied (403). The API key may lack access to this model.',
    billing: 'Claude billing issue (402). Contact the bot owner to check payment details.',
    content_filter: "Claude blocked the request due to content policy.",
    context_length: 'Claude request too large (413). Try `/reset` or send a shorter message.',
    not_found: 'Claude could not find the model or resource (404). Contact the bot owner.',
    invalid_request: 'Claude rejected the request (400 invalid_request_error). Please try again or rephrase.',
    overloaded: 'Claude is temporarily overloaded (529). Please try again shortly.',
    api_error: 'Claude returned an internal error (500). Please try again.',
    missing_api_key: "Claude isn't configured on this bot (missing ANTHROPIC_API_KEY).",
    empty_response: 'Claude returned an empty response. Please try again.',
    unknown: 'Something went wrong with Claude. Please try again.'
  },
  gemini: {
    rate_limit: 'Gemini rate limit reached (429 RESOURCE_EXHAUSTED). Please wait and try again.',
    quota_exceeded: 'Gemini quota exceeded (429 RESOURCE_EXHAUSTED). Contact the bot owner to check billing.',
    timeout: 'Gemini request timed out (504 DEADLINE_EXCEEDED). Please try again.',
    auth: 'Gemini authentication failed (401 UNAUTHENTICATED). Contact the bot owner to verify the API key.',
    permission_denied: 'Gemini permission denied (403 PERMISSION_DENIED). Contact the bot owner.',
    content_filter: "Gemini blocked the request due to safety settings or policy.",
    context_length: 'Gemini input limit exceeded (400/413). Try `/reset` or send a shorter message.',
    not_found: 'Gemini could not find the model (404 NOT_FOUND). Contact the bot owner.',
    invalid_request: 'Gemini rejected the request (400 INVALID_ARGUMENT). Please try again or rephrase.',
    overloaded: 'Gemini is temporarily unavailable (503 UNAVAILABLE). Please try again shortly.',
    api_error: 'Gemini returned a server error (500). Please try again.',
    missing_api_key: "Gemini isn't configured on this bot (missing GEMINI_API_KEY).",
    empty_response: 'Gemini returned an empty response. Please try again.',
    unknown: 'Something went wrong with Gemini. Please try again.'
  }
};

/**
 * @param {string|undefined|null} provider
 * @returns {AIProviderName|null}
 */
function normalizeAIProvider(provider) {
  if (!provider) return null;
  const normalized = String(provider).trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'claude' || normalized === 'anthropic') return 'claude';
  if (normalized === 'gemini' || normalized === 'google') return 'gemini';
  return null;
}

/**
 * @param {unknown} error
 * @returns {number|undefined}
 */
function getErrorStatus(error) {
  if (!error || typeof error !== 'object') return undefined;
  const status = error.status ?? error.statusCode ?? error.httpStatus;
  if (typeof status === 'number' && !Number.isNaN(status)) return status;
  if (typeof status === 'string' && /^\d+$/.test(status)) return Number(status);
  return undefined;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessageText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const nested = error.error;
    if (nested && typeof nested === 'object' && typeof nested.message === 'string') {
      return nested.message;
    }
    if (typeof error.message === 'string') return error.message;
  }
  return '';
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorType(error) {
  if (!error || typeof error !== 'object') return '';
  const nested = error.error;
  if (nested && typeof nested === 'object' && typeof nested.type === 'string') {
    return nested.type.toLowerCase();
  }
  if (typeof error.type === 'string') {
    const type = error.type.toLowerCase();
    if (type !== 'error') return type;
  }
  return '';
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorCode(error) {
  if (!error || typeof error !== 'object') return '';
  const nested = error.error;
  if (nested && typeof nested === 'object' && nested.code != null) {
    return String(nested.code).toLowerCase();
  }
  if (error.code != null) {
    const code = String(error.code);
    if (/^\d+$/.test(code)) return code;
    return code.toLowerCase();
  }
  return '';
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getRpcStatusCode(error) {
  if (!error || typeof error !== 'object') return '';
  const candidates = [error.status, error.statusCode, error.code];
  if (error.error && typeof error.error === 'object') {
    candidates.push(error.error.status, error.error.code, error.error.statusCode);
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]*$/.test(candidate)) {
      return candidate;
    }
  }
  return '';
}

/**
 * @param {string} message
 * @param {string} code
 * @returns {AIErrorReason|null}
 */
function classifyByMessageHints(message, code) {
  if (/quota|billing|insufficient_quota|exceeded your current quota/.test(message) || code === 'insufficient_quota') {
    return 'quota_exceeded';
  }
  if (/rate.?limit|too many requests/.test(message) || code === 'rate_limit_exceeded') {
    return 'rate_limit';
  }
  if (/timeout|timed out|deadline exceeded/.test(message) || code === 'etimedout' || code === 'econnaborted') {
    return 'timeout';
  }
  if (/context length|maximum context|token limit|too long|max_tokens|prompt is too long|input too large|request_too_large|out_of_range/.test(message) ||
      code === 'context_length_exceeded') {
    return 'context_length';
  }
  if (/content.?filter|safety|blocked|policy|harmful|moderation|refused|recitation/.test(message) ||
      code === 'content_filter') {
    return 'content_filter';
  }
  if (/invalid api key|authentication|unauthorized|unauthenticated/.test(message) ||
      code === 'invalid_api_key' || code === 'invalid_authentication') {
    return 'auth';
  }
  if (/permission denied|permission_error|not supported|forbidden/.test(message)) {
    return 'permission_denied';
  }
  if (/not found|model_not_found/.test(message) || code === 'model_not_found') {
    return 'not_found';
  }
  if (/overloaded|unavailable|engine is currently overloaded/.test(message)) {
    return 'overloaded';
  }
  if (/network|econnreset|enotfound|fetch failed|socket hang up|connection error/.test(message)) {
    return 'api_error';
  }
  return null;
}

/**
 * @param {unknown} error
 * @returns {AIErrorReason|null}
 */
function classifyOpenAIError(error) {
  const status = getErrorStatus(error);
  const type = getErrorType(error);
  const code = getErrorCode(error);
  const message = getErrorMessageText(error).toLowerCase();

  if (code === 'insufficient_quota' || (status === 429 && /quota|billing/.test(message))) {
    return 'quota_exceeded';
  }
  if (status === 429 || type === 'rate_limit_error' || code === 'rate_limit_exceeded') {
    return 'rate_limit';
  }
  if (status === 401 || type === 'authentication_error' || code === 'invalid_api_key') {
    return 'auth';
  }
  if (status === 403 || type === 'permission_denied_error') {
    return 'permission_denied';
  }
  if (status === 404 || type === 'not_found_error' || code === 'model_not_found') {
    return 'not_found';
  }
  if (status === 408 || status === 504 || type === 'timeout_error') {
    return 'timeout';
  }
  if (status === 503 || /overloaded|engine is currently overloaded/.test(message)) {
    return 'overloaded';
  }
  if (status === 413 || code === 'context_length_exceeded' || type === 'context_length_exceeded') {
    return 'context_length';
  }
  if (type === 'content_filter' || code === 'content_filter') {
    return 'content_filter';
  }
  if (status === 400 || status === 422 || type === 'invalid_request_error') {
    return classifyByMessageHints(message, code) || 'invalid_request';
  }
  if (status != null && status >= 500) {
    return 'api_error';
  }
  return classifyByMessageHints(message, code);
}

/**
 * @param {unknown} error
 * @returns {AIErrorReason|null}
 */
function classifyClaudeError(error) {
  const status = getErrorStatus(error);
  const type = getErrorType(error);
  const message = getErrorMessageText(error).toLowerCase();

  if (type === 'rate_limit_error' || status === 429) return 'rate_limit';
  if (type === 'authentication_error' || status === 401) return 'auth';
  if (type === 'billing_error' || status === 402) return 'billing';
  if (type === 'permission_error' || status === 403) return 'permission_denied';
  if (type === 'not_found_error' || status === 404) return 'not_found';
  if (type === 'timeout_error' || status === 504) return 'timeout';
  if (type === 'overloaded_error' || status === 529) return 'overloaded';
  if (type === 'request_too_large' || status === 413) return 'context_length';
  if (type === 'invalid_request_error' || status === 400) {
    return classifyByMessageHints(message, '') || 'invalid_request';
  }
  if (type === 'api_error' || (status != null && status >= 500)) return 'api_error';
  return classifyByMessageHints(message, '');
}

/**
 * @param {unknown} error
 * @returns {AIErrorReason|null}
 */
function classifyGeminiError(error) {
  const status = getErrorStatus(error);
  const rpc = getRpcStatusCode(error);
  const message = getErrorMessageText(error).toLowerCase();
  const code = getErrorCode(error);

  if (rpc === 'RESOURCE_EXHAUSTED' || status === 429) {
    return /quota|billing|limit exceeded/.test(message) ? 'quota_exceeded' : 'rate_limit';
  }
  if (rpc === 'UNAUTHENTICATED' || status === 401) return 'auth';
  if (rpc === 'PERMISSION_DENIED' || status === 403) return 'permission_denied';
  if (rpc === 'NOT_FOUND' || status === 404) return 'not_found';
  if (rpc === 'DEADLINE_EXCEEDED' || status === 504) return 'timeout';
  if (rpc === 'UNAVAILABLE' || status === 503) return 'overloaded';
  if (rpc === 'OUT_OF_RANGE' || status === 413) return 'context_length';
  if (rpc === 'INTERNAL' || rpc === 'UNKNOWN' || (status != null && status >= 500)) return 'api_error';
  if (rpc === 'INVALID_ARGUMENT' || rpc === 'FAILED_PRECONDITION' || status === 400) {
    return classifyByMessageHints(message, code) || 'invalid_request';
  }
  if (rpc === 'CANCELLED' || status === 499) return 'timeout';
  return classifyByMessageHints(message, code);
}

/**
 * Classifies an API or runtime error into a safe user-facing reason (no raw API text returned).
 *
 * @param {unknown} [error]
 * @param {string} [provider]
 * @returns {AIErrorReason}
 */
function classifyAIError(error, provider) {
  const normalizedProvider = normalizeAIProvider(provider);
  let providerReason = null;
  if (normalizedProvider === 'openai') providerReason = classifyOpenAIError(error);
  else if (normalizedProvider === 'claude') providerReason = classifyClaudeError(error);
  else if (normalizedProvider === 'gemini') providerReason = classifyGeminiError(error);
  if (providerReason) return providerReason;

  const status = getErrorStatus(error);
  const message = getErrorMessageText(error).toLowerCase();
  const code = getErrorCode(error);

  if (status === 429 || /rate.?limit|too many requests/.test(message) || code === 'rate_limit_exceeded') {
    return /quota|billing/.test(message) || code === 'insufficient_quota' ? 'quota_exceeded' : 'rate_limit';
  }
  if (
    status === 408 ||
    status === 504 ||
    code === 'etimedout' ||
    code === 'econnaborted' ||
    /timeout|timed out|deadline exceeded/.test(message)
  ) {
    return 'timeout';
  }
  if (status === 402) return 'billing';
  if (status === 401 || /unauthorized|authentication|invalid api key|api key/.test(message)) {
    return 'auth';
  }
  if (status === 403 || /permission denied|forbidden/.test(message)) {
    return 'permission_denied';
  }
  if (status === 404 || /not found/.test(message)) {
    return 'not_found';
  }
  if (status === 413 || /context length|maximum context|token limit|too long|max_tokens|prompt is too long|input too large/.test(message)) {
    return 'context_length';
  }
  if (
    /content.?filter|safety|blocked|policy|harmful|moderation|refused|recitation/.test(message) ||
    (status === 400 && /content|safety|policy/.test(message))
  ) {
    return 'content_filter';
  }
  if (status === 503 || status === 529 || /overloaded|unavailable/.test(message)) {
    return 'overloaded';
  }
  if (status != null && status >= 500) {
    return 'api_error';
  }
  if (status === 400 || status === 422) {
    return classifyByMessageHints(message, code) || 'invalid_request';
  }
  if (status != null && status >= 400) {
    return 'api_error';
  }
  if (/network|econnreset|enotfound|fetch failed|socket hang up/.test(message)) {
    return 'api_error';
  }
  return classifyByMessageHints(message, code) || 'unknown';
}

/**
 * @param {AIErrorReason} reason
 * @param {AIProviderName|null} provider
 * @returns {string}
 */
function getAIErrorMessageBody(reason, provider) {
  if (provider && PROVIDER_ERROR_MESSAGES[provider]?.[reason]) {
    return PROVIDER_ERROR_MESSAGES[provider][reason];
  }
  return DEFAULT_ERROR_MESSAGES[reason] || DEFAULT_ERROR_MESSAGES.unknown;
}

/**
 * Formats a short, safe user-facing Discord message for AI failures.
 *
 * @param {{ reason?: AIErrorReason, error?: unknown, provider?: string }} [options]
 * @returns {string}
 */
function formatAIUserMessage(options = {}) {
  const { error, provider } = options;
  const normalizedProvider = normalizeAIProvider(provider);
  let reason = options.reason;
  if (!reason && error) {
    reason = classifyAIError(error, provider);
  }
  if (!reason) {
    reason = 'unknown';
  }
  const body = getAIErrorMessageBody(reason, normalizedProvider);
  return `⚠️ ${body}`;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isAIUserErrorMessage(text) {
  return typeof text === 'string' && text.startsWith('⚠️ ');
}

/**
 * @param {AIErrorReason} reason
 * @returns {boolean}
 */
function isBusyAIErrorReason(reason) {
  return reason === 'overloaded' || reason === 'rate_limit';
}

module.exports = {
  assertDiscordImageDownloadUrl,
  splitMessage,
  downloadImageAsBase64,
  createMessageContent,
  collectReplyChainMedia,
  normalizeMediaUrl,
  inferImageContentTypeFromUrl,
  processImageAttachments,
  hasImages,
  estimateTokensFromText,
  trimConversationHistory,
  pruneStaleMapEntries,
  normalizeConversationRoles,
  pruneChannelAuxMaps,
  pruneConversationHistories,
  stripImagesFromHistory,
  createSystemMessage,
  classifyAIError,
  formatAIUserMessage,
  isAIUserErrorMessage,
  isBusyAIErrorReason,
  classifyAIError,
  isSupportedVisionImageType,
  SYSTEM_MESSAGES
};
