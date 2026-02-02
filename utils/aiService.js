const { OpenAI } = require('openai');
const { GoogleGenAI } = require('@google/genai');
const {
  openaiApiKey,
  geminiApiKey,
  modelName,
  getTemperature,
  reasoningEffort,
  responsesVerbosity,
  aiProvider
} = require('../config');
const path = require('path');
const logger = require('../logger')(path.basename(__filename));
const { hasImages, SYSTEM_MESSAGES } = require('./aiUtils');

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
 * OpenAI client instance configured with API key (used when aiProvider === 'openai').
 * @type {OpenAI}
 */
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

/**
 * Google GenAI client (used when aiProvider === 'gemini').
 * @type {GoogleGenAI|null}
 */
const genAI = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

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
          if (item.type === 'input_image' && item.image_url) {
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
    temperature: getTemperature()
  };
  if (systemWithImageHint) config.systemInstruction = systemWithImageHint;

  logger.debug(`Sending conversation to Gemini API using model: ${modelName}.`, {
    messageCount: conversation.length,
    model: modelName,
    contentsLength: contents.length,
    hasImages: hasImages(conversation)
  });

  try {
    const response = await genAI.models.generateContent({
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
    logger.error('Gemini API request failed.', {
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

    let messages = [...conversation];
    if (hasImages(conversation)) {
      messages.push({
        role: 'system',
        content: SYSTEM_MESSAGES.IMAGE_ANALYSIS
      });
    }

    const requestParams = {
      model: modelName,
      input: messages
    };

    const normalizedReasoningEffort = typeof reasoningEffort === 'string'
      ? reasoningEffort.trim().toLowerCase()
      : '';

    if (['low', 'medium', 'high'].includes(normalizedReasoningEffort)) {
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
      hasImages: hasImages(conversation)
    });

    let response;
    try {
      response = await openai.responses.create(requestParams);
    } catch (apiError) {
      logger.error('API request failed.', {
        error: apiError.stack,
        message: apiError.message,
        model: modelName,
        statusCode: apiError.status || 'unknown'
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
    logger.error('Error generating AI response:', {
      error: error.stack,
      message: error.message,
      model: modelName,
      errorType: error.type || 'unknown',
      errorCode: error.code || 'unknown',
      statusCode: error.status || 'unknown'
    });
    return '';
  }
}

/**
 * Generates an AI response using the configured provider (OpenAI or Gemini).
 *
 * @param {Array<{role: string, content: string|Array}>} conversation - Array of conversation messages
 * @returns {Promise<string>} The generated AI response, or empty string if generation fails
 */
async function generateAIResponse(conversation) {
  if (!conversation || conversation.length === 0) {
    logger.error('Cannot generate AI response; empty conversation provided.');
    return '';
  }

  if (aiProvider === 'gemini') {
    return generateGeminiResponse(conversation);
  }
  return generateOpenAIResponse(conversation);
}



module.exports = { 
  generateAIResponse
};
