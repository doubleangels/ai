const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

test('OpenAI API failure results in empty reply', async () => {
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'fake';

  const fakeOpenAI = {
    OpenAI: class {
      constructor() { this.responses = { create: async () => { throw Object.assign(new Error('service down'), { status: 500 }); } }; }
    }
  };

  const openaiPath = require.resolve('openai');
  require.cache[openaiPath] = { id: openaiPath, filename: openaiPath, loaded: true, exports: fakeOpenAI };

  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../utils/aiService')];
  const aiService = require('../utils/aiService');

  const reply = await aiService.generateAIResponse([{ role: 'system', content: 'sys' }, { role: 'user', content: 'ping' }]);
  assert.equal(typeof reply, 'string');
});
