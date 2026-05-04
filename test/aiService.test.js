const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Helpers to stub modules before requiring aiService
function stubModule(resolvedName, exportsObj) {
  try {
    const resolved = require.resolve(resolvedName);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: exportsObj
    };
    return resolved;
  } catch (e) {
    // if resolution fails, skip stub (module may not be installed)
    return null;
  }
}

test('generateAIResponse uses OpenAI when configured', async () => {
  // Arrange: set env and stub OpenAI
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'fake';

  const fakeOpenAI = {
    OpenAI: class {
      constructor() { this.responses = { create: async () => ({ status: 'completed', output_text: 'hello from openai', id: 'r1', usage: { total_tokens: 10 } }) }; }
    }
  };
  stubModule('openai', fakeOpenAI);

  // Clear config and aiService from cache so they pick up env + stubs
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../utils/aiService')];

  const aiService = require('../utils/aiService');

  const reply = await aiService.generateAIResponse([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.equal(reply.includes('hello from openai'), true);
});

test('generateAIResponse uses Gemini when configured', async () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'fake';

  const fakeGen = {
    GoogleGenAI: class { constructor() { this.models = { generateContent: async () => ({ text: 'hello gemini' }) }; } }
  };
  stubModule('@google/genai', fakeGen);

  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../utils/aiService')];

  const aiService = require('../utils/aiService');
  const reply = await aiService.generateAIResponse([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.equal(typeof reply, 'string');
});

test('generateAIResponse uses Claude when configured', async () => {
  process.env.AI_PROVIDER = 'claude';
  process.env.ANTHROPIC_API_KEY = 'fake';

  const fakeAnthropic = function FakeAnthropic() {
    this.messages = { create: async () => ({ content: [{ type: 'text', text: 'hello claude' }] }) };
  };
  stubModule('@anthropic-ai/sdk', fakeAnthropic);

  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../utils/aiService')];

  const aiService = require('../utils/aiService');
  const reply = await aiService.generateAIResponse([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.equal(typeof reply, 'string');
});
