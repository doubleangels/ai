const {
  sanitizeLogMeta,
  serializeError,
  safeAttachmentLabel,
  stripUrlQuery,
  isSecretKey,
  isUrlKey,
  REDACTED
} = require('../utils/logSanitize');

test('should sanitizeLogMeta redacts secret keys', () => {
  const result = sanitizeLogMeta({
    userId: '1',
    token: 'secret-token',
    openaiApiKey: 'sk-test',
    content: 'hello world'
  });
  expect(result.userId).toBe('1');
  expect(result.token).toBe(REDACTED);
  expect(result.openaiApiKey).toBe(REDACTED);
  expect(result.content).toBe(REDACTED);
});

test('should sanitizeLogMeta preserves display names', () => {
  const result = sanitizeLogMeta({
    user: 'User#0001',
    channelName: 'general',
    guildName: 'Test Guild'
  });
  expect(result.user).toBe('User#0001');
  expect(result.channelName).toBe('general');
  expect(result.guildName).toBe('Test Guild');
});

test('should sanitizeLogMeta strips URL query strings', () => {
  const result = sanitizeLogMeta({
    url: 'https://cdn.discordapp.com/attachments/1/2/file.png?ex=abc&is=def'
  });
  expect(result.url).toBe('https://cdn.discordapp.com/attachments/1/2/file.png');
});

test('should sanitizeLogMeta handles nested objects', () => {
  const result = sanitizeLogMeta({
    headers: { authorization: 'Bearer xyz' },
    meta: { geminiApiKey: 'key' }
  });
  expect(result.headers.authorization).toBe(REDACTED);
  expect(result.meta.geminiApiKey).toBe(REDACTED);
});

test('should serializeError returns safe fields', () => {
  const err = new Error('rate limited');
  err.status = 429;
  err.stack = 'Error: rate limited\n    at foo\n    at bar';
  const result = serializeError(err);
  expect(result.errorName).toBe('Error');
  expect(result.errorMessage).toBe('rate limited');
  expect(result.httpStatus).toBe(429);
  expect(result.stack).toBeUndefined();
});

test('should serializeError includes truncated stack when requested', () => {
  const err = new Error('fail');
  err.stack = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
  const result = serializeError(err, { includeStack: true });
  expect(result.stack.split('\n').length).toBeLessThanOrEqual(8);
});

test('should safeAttachmentLabel avoids raw URLs', () => {
  expect(safeAttachmentLabel({ id: '123', url: 'https://example.com/x?token=abc' })).toBe('attachment:123');
  expect(safeAttachmentLabel({ filename: 'pic.png', url: 'https://example.com/x' })).toBe('file:pic.png');
  expect(safeAttachmentLabel({ contentType: 'image/png' })).toBe('media:image/png');
});

test('should stripUrlQuery removes query portion', () => {
  expect(stripUrlQuery('https://a.com/b?x=1')).toBe('https://a.com/b');
});

test('should stripUrlQuery falls back for invalid URLs', () => {
  expect(stripUrlQuery('/relative/path?x=1')).toBe('/relative/path');
  expect(stripUrlQuery('plain-text')).toBe('plain-text');
});

test('should sanitizeLogMeta handles arrays and nested error objects', () => {
  const err = new Error('nested fail');
  err.stack = 'Error: nested fail\n    at x';
  const result = sanitizeLogMeta({
    items: [{ token: 'secret' }],
    error: err
  });
  expect(result.items[0].token).toBe(REDACTED);
  expect(result.error.errorMessage).toBe('nested fail');
  expect(result.error.stack).toBeDefined();
});

test('should sanitizeLogMeta handles top-level arrays', () => {
  const result = sanitizeLogMeta([{ url: 'https://a.com/x?y=1' }, { token: 'secret' }]);
  expect(result[0].url).toBe('https://a.com/x');
  expect(result[1].token).toBe(REDACTED);
});

test('should safeAttachmentLabel uses name and default fallbacks', () => {
  expect(safeAttachmentLabel({ name: 'pic.png' })).toBe('file:pic.png');
  expect(safeAttachmentLabel({})).toBe('attachment');
  expect(safeAttachmentLabel(null)).toBe('attachment');
});

test('should serializeError returns empty object for falsy errors', () => {
  expect(serializeError(null)).toEqual({});
  expect(serializeError(undefined)).toEqual({});
});

test('should stripUrlQuery returns empty values unchanged', () => {
  expect(stripUrlQuery('')).toBe('');
});

function containsRedacted(value) {
  if (value === REDACTED) return true;
  if (Array.isArray(value)) return value.some(containsRedacted);
  if (value && typeof value === 'object') {
    return Object.values(value).some(containsRedacted);
  }
  return false;
}

test('should sanitizeLogMeta truncates deeply nested metadata', () => {
  expect(sanitizeLogMeta({ token: 'secret' }, 9)).toEqual({ truncated: true });
});

test('should sanitizeLogMeta redacts values beyond max sanitize depth', () => {
  let obj = ['deep-value'];
  for (let i = 0; i < 5; i += 1) {
    obj = { child: obj };
  }
  const result = sanitizeLogMeta(obj);
  expect(containsRedacted(result)).toBe(true);
  expect(sanitizeLogMeta({ keep: 'value' }, 8)).toEqual({ keep: REDACTED });
});

test('should isSecretKey and isUrlKey reject non-string keys', () => {
  expect(isSecretKey(null)).toBe(false);
  expect(isUrlKey(undefined)).toBe(false);
});
