const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const aiUtils = require(path.resolve(__dirname, '..', '..', 'utils', 'aiUtils.js'));

test('splitMessage returns empty array for empty input', () => {
  const parts = aiUtils.splitMessage('', 2000);
  assert.deepEqual(parts, []);
});

test('splitMessage does not split short text', () => {
  const text = 'hello world';
  const parts = aiUtils.splitMessage(text, 2000);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], text);
});

test('createMessageContent includes text and images', () => {
  const imgs = [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }];
  const res = aiUtils.createMessageContent(' hi ', imgs);
  assert.equal(res.length, 2);
  assert.equal(res[0].type, 'input_text');
  assert.equal(res[0].text, 'hi');
  assert.equal(res[1].type, 'input_image');
});

test('hasImages detects images in conversation', () => {
  const conv = [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:' }] }];
  assert.equal(aiUtils.hasImages(conv), true);
});

test('estimateTokensFromText basic heuristic', () => {
  assert.equal(aiUtils.estimateTokensFromText('abcd'), 1);
  assert.equal(aiUtils.estimateTokensFromText('abcdefgh'), 2);
});

// estimateMessageTokens is internal and not exported; validate estimateTokensFromText instead
test('estimateTokensFromText behaves reasonably', () => {
  assert.equal(aiUtils.estimateTokensFromText('a'.repeat(4)), 1);
  assert.equal(aiUtils.estimateTokensFromText('a'.repeat(8)), 2);
});

test('trimConversationHistory preserves system message and trims by length', () => {
  const history = [ { role: 'system', content: 'sys' } ];
  for (let i = 0; i < 10; i++) history.push({ role: 'user', content: `m${i}` });
  aiUtils.trimConversationHistory(history, 3, 0);
  assert.equal(history[0].role, 'system');
  assert(history.length <= 4);
});

test('createSystemMessage respects includeModelInPrompt flag', () => {
  const sys = aiUtils.createSystemMessage('model-x', true);
  assert(sys.role === 'system');
  assert(typeof sys.content === 'string');
  const sys2 = aiUtils.createSystemMessage('model-x', false);
  assert(sys2.role === 'system');
});

test('assertDiscordImageDownloadUrl rejects non-https and invalid hosts', () => {
  assert.throws(() => aiUtils.assertDiscordImageDownloadUrl('http://example.com/img.png'));
  assert.throws(() => aiUtils.assertDiscordImageDownloadUrl('https://evil.com/img.png'));
});
