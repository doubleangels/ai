const { OpenAI } = require('openai');
const { GoogleGenAI } = require('@google/genai');
const Anthropic = require('@anthropic-ai/sdk');
const {
  openaiApiKey,
  geminiApiKey,
  anthropicApiKey,
  modelName,
  getTemperature,
  reasoningEffort,
  responsesVerbosity,
  aiProvider,
  enableWebSearch,
  enableGoogleMaps,
  maxOutputTokens,
  enableContextCache,
  geminiCacheTtlSeconds,
  claudeThinkingBudgetTokens,
  geminiSafetySettings,
  openaiTimeoutMs,
  openaiMaxRetries
} = require('../config');
const { captureError, recordCount, recordDistribution, startSpan } = require('../instrument');
const path = require('path');
const logger = require('../logger')(path.basename(__filename));
const { hasImages, SYSTEM_MESSAGES, estimateTokensFromText } = require('./aiUtils');

/** Gemini context cache minimum token count (API requirement; Flash 1024, Pro 4096 — use 2048 to be safe). */
const GEMINI_MIN_CACHE_TOKENS = 2048;

/**
 * Determines if the model supports custom temperature values.
 * All models support custom temperature in the Responses API.
 *
 * @param {string} model - The model name
 * @returns {boolean} True if the model supports custom temperature
 */
function supportsCustomTemperature(model) {
  return true;
}

/**
 * OpenAI client instance configured with API key, timeout, and retries (used when aiProvider === 'openai').
 * @type {OpenAI}
 */
const openai = openaiApiKey
  ? new OpenAI({
      apiKey: openaiApiKey,
      timeout: openaiTimeoutMs,
      maxRetries: openaiMaxRetries
    })
  : null;

/**
 * Google GenAI client (used when aiProvider === 'gemini').
 * @type {GoogleGenAI|null}
 */
const genAI = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

/**
 * Anthropic client (used when aiProvider === 'claude').
 * @type {Anthropic|null}
 */
const anthropic = anthropicApiKey ? new Anthropic({ apiKey: anthropicApiKey }) : null;

/** In-memory Gemini context cache: one entry for system instruction (reused across channels). */
let geminiCacheEntry = null;

/** Claude model IDs that support extended thinking (4.5 family and Sonnet/Opus 4). */
const CLAUDE_EXTENDED_THINKING_MODELS = [
  'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5',
  'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101',
  'claude-sonnet-4-20250514'
];

function claudeSupportsExtendedThinking(model) {
  return CLAUDE_EXTENDED_THINKING_MODELS.some(m => model && model.startsWith(m));
}

/** Claude tools: optional tools the model can call. */
const CLAUDE_TOOLS = [
  {
    name: 'get_current_time',
    description: 'Returns the current date and time in ISO 8601 format (UTC). Use when the user asks for the current time, date, or "now".',
    input_schema: { type: 'object', properties: {}, additional_properties: false }
  }
];

/**
 * Executes a Claude tool by name and returns the result string.
 * @param {string} name - Tool name
 * @param {Object} input - Tool input
 * @returns {string} Result to send back to Claude
 */
function executeClaudeTool(name, input) {
  if (name === 'get_current_time') {
    return new Date().toISOString();
  }
  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

/**
 * Parses a data URL (e.g. data:image/png;base64,XXX) into mimeType and base64 data for Gemini.
 * @param {string} dataUrl - data URL string
 * @returns {{ mimeType: string, data: string }|null}
 */
function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1].trim(), data: match[2].trim() };
}

/**
 * Converts internal conversation format to Gemini API contents and systemInstruction.
 * @param {Array<{role: string, content: string|Array}>} conversation - Internal conversation messages
 * @returns {{ systemInstruction: string|undefined, contents: Array<{ role: string, parts: Array }> }}
 */
function conversationToGeminiFormat(conversation) {
  let systemInstruction;
  const contents = [];

  for (const msg of conversation) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.trim()) systemInstruction = text;
      continue;
    }

    if (msg.role === 'user') {
      const parts = [];
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === 'input_text' && typeof item.text === 'string' && item.text.trim()) {
            parts.push({ text: item.text.trim() });
          }
          if (item.type === 'input_image') {
            const parsed = parseDataUrl(item.image_url);
            if (parsed) parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        parts.push({ text: content.trim() });
      }
      if (parts.length > 0) contents.push({ role: 'user', parts });
      continue;
    }

    if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.trim()) contents.push({ role: 'model', parts: [{ text: text.trim() }] });
    }
  }

  return { systemInstruction, contents };
}

/**
 * Converts internal conversation format to Claude API system and messages.
 * @param {Array<{role: string, content: string|Array}>} conversation - Internal conversation messages
 * @returns {{ system: string|undefined, messages: Array<{ role: string, content: string|Array }> }}
 */
function conversationToClaudeFormat(conversation) {
  let system;
  const messages = [];

  for (const msg of conversation) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.trim()) system = text;
      continue;
    }

    if (msg.role === 'user') {
      const content = msg.content;
      if (Array.isArray(content)) {
        const blocks = [];
        for (const item of content) {
          if (item.type === 'input_text' && typeof item.text === 'string' && item.text.trim()) {
            blocks.push({ type: 'text', text: item.text.trim() });
          }
          if (item.type === 'input_image' && item.image_url) {
            const parsed = parseDataUrl(item.image_url);
            if (parsed) {
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: parsed.mimeType, data: parsed.data }
              });
            }
          }
        }
        if (blocks.length > 0) messages.push({ role: 'user', content: blocks });
      } else if (typeof content === 'string' && content.trim()) {
        messages.push({ role: 'user', content: content.trim() });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.trim()) messages.push({ role: 'assistant', content: text.trim() });
    }
  }

  return { system, messages };
}

/**
 * Generates an AI response using the Gemini API.
 * @param {Array<{role: string, content: string|Array}>} conversation - Conversation history
 * @returns {Promise<string>} Generated reply or empty string on failure
 */
async function generateGeminiResponse(conversation) {
  if (!genAI) {
    logger.error('Gemini API key not configured (GEMINI_API_KEY).');
    return '';
  }

  const { systemInstruction, contents } = conversationToGeminiFormat(conversation);
  if (contents.length === 0) {
    logger.error('No valid user/model turns for Gemini.');
    return '';
  }

  let systemWithImageHint = systemInstruction;
  if (hasImages(conversation) && systemInstruction) {
    systemWithImageHint = systemInstruction + '\n\n' + SYSTEM_MESSAGES.IMAGE_ANALYSIS;
  } else if (hasImages(conversation)) {
    systemWithImageHint = SYSTEM_MESSAGES.IMAGE_ANALYSIS;
  }

  const config = {
    temperature: getTemperature(),
    maxOutputTokens
  };

  let useCachedContent = false;
  const systemTokenEstimate = systemWithImageHint ? estimateTokensFromText(systemWithImageHint) : 0;
  const meetsMinForCache = systemTokenEstimate >= GEMINI_MIN_CACHE_TOKENS;

  if (enableContextCache && systemWithImageHint && genAI.caches && meetsMinForCache) {
    const now = Date.now();
    if (geminiCacheEntry && geminiCacheEntry.systemInstruction === systemWithImageHint && geminiCacheEntry.expiresAt > now) {
      config.cachedContent = geminiCacheEntry.name;
      useCachedContent = true;
    } else {
      try {
        const cache = await genAI.caches.create({
          model: modelName,
          config: {
            systemInstruction: systemWithImageHint,
            ttl: `${geminiCacheTtlSeconds}s`,
            displayName: 'ai-bot-system'
          }
        });
        const expiresAt = now + geminiCacheTtlSeconds * 1000;
        geminiCacheEntry = { name: cache.name, expiresAt, systemInstruction: systemWithImageHint };
        config.cachedContent = cache.name;
        useCachedContent = true;
        logger.debug('Created Gemini context cache.', { name: cache.name, ttlSeconds: geminiCacheTtlSeconds });
      } catch (cacheErr) {
        logger.warn('Gemini context cache creation failed, falling back to uncached.', {
          message: cacheErr?.message
        });
        config.systemInstruction = systemWithImageHint;
      }
    }
  }
  if (!useCachedContent && systemWithImageHint) config.systemInstruction = systemWithImageHint;
  // Gemini API: google_search and google_maps cannot be used in the same request (400 INVALID_ARGUMENT).
  let geminiUseWebSearch = enableWebSearch;
  let geminiUseMaps = enableGoogleMaps;
  if (enableWebSearch && enableGoogleMaps) {
    geminiUseMaps = false;
    logger.warn(
      'ENABLE_WEB_SEARCH and ENABLE_GOOGLE_MAPS are both on; Gemini allows only one per request. Using Google Search grounding only. Disable ENABLE_WEB_SEARCH to use Maps.'
    );
  }
  if (geminiUseWebSearch || geminiUseMaps) {
    config.tools = [];
    if (geminiUseWebSearch) config.tools.push({ googleSearch: {} });
    if (geminiUseMaps) config.tools.push({ googleMaps: {} });
  }
  if (geminiSafetySettings && geminiSafetySettings.length > 0) {
    config.safetySettings = geminiSafetySettings;
  }

  logger.debug(`Sending conversation to Gemini API using model: ${modelName}.`, {
    messageCount: conversation.length,
    model: modelName,
    contentsLength: contents.length,
    searchGrounding: geminiUseWebSearch,
    mapsGrounding: geminiUseMaps,
    hasImages: hasImages(conversation),
    usingContextCache: useCachedContent,
    safetySettings: config.safetySettings ? config.safetySettings.length : 0
  });

  let response;
  try {
    response = await genAI.models.generateContent({
      model: modelName,
      contents: contents,
      config
    });

    const text = (typeof response?.text === 'function' ? response.text() : response?.text) ?? '';
    if (!text || !text.trim()) {
      logger.warn('Gemini response is empty.');
      return 'I apologize, but I couldn\'t generate a response. Please try again.';
    }

    logger.info('Generated AI response successfully (Gemini):', {
      charCount: text.length,
      model: modelName
    });
    return text.trim();
  } catch (apiError) {
    const errMsg = typeof apiError?.message === 'string' ? apiError.message : '';
    const isLikelyStaleCache = useCachedContent && (
      apiError?.status === 404 ||
      apiError?.code === 404 ||
      (/cachedcontent|cached.?content/i.test(errMsg) && /not\s*found|NOT_FOUND|expired|was\s+deleted/i.test(errMsg))
    );
    if (isLikelyStaleCache) {
      geminiCacheEntry = null;
      logger.warn('Gemini cached content likely expired or invalid, retrying without cache.', {
        message: apiError?.message
      });
      const retryConfig = { ...config };
      delete retryConfig.cachedContent;
      if (systemWithImageHint) retryConfig.systemInstruction = systemWithImageHint;
      try {
        response = await genAI.models.generateContent({
          model: modelName,
          contents: contents,
          config: retryConfig
        });
        const retryText = (typeof response?.text === 'function' ? response.text() : response?.text) ?? '';
        if (retryText && retryText.trim()) {
          logger.info('Generated AI response successfully (Gemini, retry without cache).', {
            charCount: retryText.length,
            model: modelName
          });
          return retryText.trim();
        }
      } catch (retryErr) {
        captureError(retryErr, { provider: 'gemini', handler: 'retryWithoutCache' });
        logger.error('Gemini API retry without cache failed.', {
          error: retryErr?.stack,
          message: retryErr?.message,
          model: modelName
        });
        return '';
      }
    }
    captureError(apiError, { provider: 'gemini' });
    logger.error('Gemini API request failed.', {
      error: apiError?.stack,
      message: apiError?.message,
      model: modelName
    });
    return '';
  }
}

/**
 * Generates an AI response using the Claude (Anthropic) API.
 * @param {Array<{role: string, content: string|Array}>} conversation - Conversation history
 * @returns {Promise<string>} Generated reply or empty string on failure
 */
async function generateClaudeResponse(conversation) {
  if (!anthropic) {
    logger.error('Anthropic API key not configured (ANTHROPIC_API_KEY).');
    return '';
  }

  const { system, messages } = conversationToClaudeFormat(conversation);
  if (messages.length === 0) {
    logger.error('No valid user/assistant turns for Claude.');
    return '';
  }

  let systemWithImageHint = system;
  if (hasImages(conversation) && system) {
    systemWithImageHint = system + '\n\n' + SYSTEM_MESSAGES.IMAGE_ANALYSIS;
  } else if (hasImages(conversation)) {
    systemWithImageHint = SYSTEM_MESSAGES.IMAGE_ANALYSIS;
  }

  const params = {
    model: modelName,
    max_tokens: maxOutputTokens,
    messages,
    temperature: getTemperature()
  };
  if (systemWithImageHint) {
    if (enableContextCache) {
      params.system = [{ type: 'text', text: systemWithImageHint, cache_control: { type: 'ephemeral' } }];
    } else {
      params.system = systemWithImageHint;
    }
  }

  if (claudeThinkingBudgetTokens > 0 && claudeSupportsExtendedThinking(modelName)) {
    params.thinking = { type: 'enabled', budget_tokens: claudeThinkingBudgetTokens };
  }

  params.tools = CLAUDE_TOOLS;

  logger.debug(`Sending conversation to Claude API using model: ${modelName}.`, {
    messageCount: conversation.length,
    model: modelName,
    messagesLength: messages.length,
    hasImages: hasImages(conversation),
    promptCacheEnabled: enableContextCache,
    extendedThinking: params.thinking ? params.thinking.budget_tokens : undefined
  });

  try {
    let currentMessages = [...messages];
    const maxToolRounds = 5;
    let round = 0;
    let response;

    while (round < maxToolRounds) {
      response = await anthropic.messages.create({ ...params, messages: currentMessages });

      const toolUseBlocks = (response.content || []).filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) {
        const textBlock = response.content && response.content.find(b => b.type === 'text');
        const text = (textBlock && textBlock.text && textBlock.text.trim()) ? textBlock.text.trim() : '';
        if (!text) {
          logger.warn('Claude response is empty.');
          return 'I apologize, but I couldn\'t generate a response. Please try again.';
        }
        logger.info('Generated AI response successfully (Claude):', {
          charCount: text.length,
          model: modelName,
          toolRounds: round
        });
        return text;
      }

      const toolResults = toolUseBlocks.map(block => ({
        type: 'tool_result',
        tool_use_id: block.id,
        content: executeClaudeTool(block.name, block.input || {})
      }));

      currentMessages.push({ role: 'assistant', content: response.content });
      currentMessages.push({ role: 'user', content: toolResults });
      round++;
      logger.debug('Claude tool use round.', { round, tools: toolUseBlocks.map(b => b.name) });
    }

    const textBlock = response.content && response.content.find(b => b.type === 'text');
    const text = (textBlock && textBlock.text && textBlock.text.trim()) ? textBlock.text.trim() : '';
    if (text) return text;
    logger.warn('Claude hit max tool rounds without final text.');
    return 'I apologize, but I couldn\'t complete that request. Please try again.';
  } catch (apiError) {
    captureError(apiError, { provider: 'claude' });
    logger.error('Claude API request failed.', {
      error: apiError?.stack,
      message: apiError?.message,
      model: modelName
    });
    return '';
  }
}

/**
 * Generates an AI response using OpenAI's API based on the provided conversation history.
 *
 * @param {Array<{role: string, content: string|Array}>} conversation - Array of conversation messages
 * @returns {Promise<string>} The generated AI response, or empty string if generation fails
 */
async function generateOpenAIResponse(conversation) {
  if (!openai) {
    logger.error('OpenAI API key not configured (OPENAI_API_KEY).');
    return '';
  }

  try {
    const supportsTemp = supportsCustomTemperature(modelName);

    // Keep system and static content first for OpenAI automatic prompt caching (≥1024 tokens; cache-friendly order).
    let messages = [...conversation];
    if (hasImages(conversation)) {
      const sysIdx = messages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0 && typeof messages[sysIdx].content === 'string') {
        messages[sysIdx] = {
          role: 'system',
          content: `${messages[sysIdx].content}\n\n${SYSTEM_MESSAGES.IMAGE_ANALYSIS}`
        };
      } else {
        messages.unshift({
          role: 'system',
          content: SYSTEM_MESSAGES.IMAGE_ANALYSIS
        });
      }
    }

    const requestParams = {
      model: modelName,
      input: messages,
      max_output_tokens: maxOutputTokens
    };

    const normalizedReasoningEffort = typeof reasoningEffort === 'string'
      ? reasoningEffort.trim().toLowerCase()
      : '';

    if (['none', 'low', 'medium', 'high', 'xhigh'].includes(normalizedReasoningEffort)) {
      requestParams.reasoning = { effort: normalizedReasoningEffort };
    }

    const normalizedVerbosity = typeof responsesVerbosity === 'string'
      ? responsesVerbosity.trim().toLowerCase()
      : '';

    if (['low', 'medium', 'high'].includes(normalizedVerbosity)) {
      requestParams.text = {
        ...(requestParams.text || {}),
        verbosity: normalizedVerbosity
      };
    }

    if (enableWebSearch) {
      requestParams.tools = [{ type: 'web_search' }];
    }

    let temperatureValue = null;
    if (supportsCustomTemperature(modelName)) {
      const temperature = getTemperature();
      requestParams.temperature = temperature;
      temperatureValue = temperature;
    }

    logger.debug(`Sending conversation to OpenAI API using model: ${modelName}.`, {
      messageCount: conversation.length,
      model: modelName,
      temperature: temperatureValue,
      reasoningEffort: normalizedReasoningEffort || undefined,
      verbosity: normalizedVerbosity || undefined,
      webSearch: enableWebSearch,
      hasImages: hasImages(conversation)
    });

    let response;
    try {
      response = await openai.responses.create(requestParams);
    } catch (apiError) {
      captureError(apiError, { provider: 'openai' });
      logger.error('API request failed.', {
        error: apiError?.stack,
        message: apiError?.message,
        model: modelName,
        statusCode: apiError?.status ?? 'unknown'
      });
      return '';
    }

    logger.debug('Received response from OpenAI API:', {
      responseId: response.id,
      status: response.status,
      totalTokens: response.usage?.total_tokens
    });

    const reply = response.output_text || '';

    if (response.status !== 'completed') {
      logger.warn('OpenAI API response not completed:', {
        model: modelName,
        responseStatus: response.status,
        responseId: response.id,
        incompleteDetails: response.incomplete_details || undefined,
        hasOutputText: Boolean(reply && reply.trim())
      });

      if (reply && reply.trim()) return reply;
      return '';
    }

    if (!reply || reply.trim() === '') {
      logger.warn('Response is empty.');
      return 'I apologize, but I couldn\'t generate a response. Please try again.';
    }

    logger.info('Generated AI response successfully:', {
      responseId: response.id,
      charCount: reply.length,
      tokensUsed: response.usage?.total_tokens
    });

    return reply;
  } catch (error) {
    captureError(error, { provider: aiProvider || 'unknown' });
    logger.error('Error generating AI response:', {
      error: error?.stack,
      message: error?.message,
      model: modelName,
      errorType: error?.type ?? 'unknown',
      errorCode: error?.code ?? 'unknown',
      statusCode: error?.status ?? 'unknown'
    });
    return '';
  }
}

/**
 * Generates an AI response using the configured provider (OpenAI, Gemini, or Claude).
 *
 * @param {Array<{role: string, content: string|Array}>} conversation - Array of conversation messages
 * @returns {Promise<string>} The generated AI response, or empty string if generation fails
 */
async function generateAIResponse(conversation) {
  if (!conversation || conversation.length === 0) {
    logger.error('Cannot generate AI response; empty conversation provided.');
    recordCount('ai.generate.requests', 1, {
      provider: aiProvider,
      outcome: 'empty_conversation'
    });
    return '';
  }

  const startedAt = Date.now();

  return startSpan({
    op: 'ai.generate',
    name: `Generate AI response (${aiProvider})`
  }, async () => {
    try {
      let reply;
      if (aiProvider === 'gemini') {
        reply = await generateGeminiResponse(conversation);
      } else if (aiProvider === 'claude') {
        reply = await generateClaudeResponse(conversation);
      } else {
        reply = await generateOpenAIResponse(conversation);
      }

      recordCount('ai.generate.requests', 1, {
        provider: aiProvider,
        outcome: reply ? 'success' : 'empty'
      });
      recordDistribution('ai.generate.duration_ms', Date.now() - startedAt, {
        unit: 'millisecond',
        attributes: {
          provider: aiProvider,
          outcome: reply ? 'success' : 'empty'
        }
      });

      return reply;
    } catch (error) {
      captureError(error, { provider: aiProvider || 'unknown', handler: 'generateAIResponse' });
      recordCount('ai.generate.requests', 1, {
        provider: aiProvider,
        outcome: 'error'
      });
      recordDistribution('ai.generate.duration_ms', Date.now() - startedAt, {
        unit: 'millisecond',
        attributes: {
          provider: aiProvider,
          outcome: 'error'
        }
      });
      throw error;
    }
  });
}



module.exports = { 
  generateAIResponse
};
