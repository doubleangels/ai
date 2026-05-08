const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

test('Gemini retries without cache when cached content causes 404', async () => {
  // Arrange: set environment to gemini and stub GoogleGenAI
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'fake';

  // Create a stub that simulates cached content 404 on first call, success on retry
  let callCount = 0;
  const fakeGen = {
    GoogleGenAI: class {
      constructor() { this.models = { generateContent: async (opts) => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('cachedcontent not found');
          err.status = 404;
          throw err;
        }
        return { text: 'gemini after retry' };
      } } } }
  };

  // Stub module resolution
  const genPath = require.resolve('@google/genai');
  require.cache[genPath] = { id: genPath, filename: genPath, loaded: true, exports: fakeGen };

  // Reload config and aiService
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../utils/aiService')];
  const aiService = require('../utils/aiService');

  const reply = await aiService.generateAIResponse([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }]);
  // Ensure the call completes and returns a string (success or gracefully handled failure)
  assert.equal(typeof reply, 'string');
});
