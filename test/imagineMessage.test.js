const { IMAGINE_EMBED_TITLE, isImagineImageMessage } = require('../utils/imagineMessage');

test('isImagineImageMessage returns true for imagine embed title', () => {
  expect(isImagineImageMessage({
    embeds: [{ title: IMAGINE_EMBED_TITLE }]
  })).toBe(true);
});

test('isImagineImageMessage returns false for other bot messages', () => {
  expect(isImagineImageMessage({
    embeds: [{ title: 'Something else' }]
  })).toBe(false);
  expect(isImagineImageMessage({ embeds: [] })).toBe(false);
  expect(isImagineImageMessage(null)).toBe(false);
});
