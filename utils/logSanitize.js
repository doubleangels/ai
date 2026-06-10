const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERNS = [
  /^token$/i,
  /^secret$/i,
  /^password$/i,
  /^authorization$/i,
  /^cookie$/i,
  /^dopplerToken$/i,
  /^discordBotToken$/i,
  /^apiKey$/i,
  /ApiKey$/i,
  /^openaiApiKey$/i,
  /^geminiApiKey$/i,
  /^anthropicApiKey$/i,
  /^content$/i,
  /^body$/i,
  /^prompt$/i,
  /^base64$/i,
  /^input$/i,
  /^output$/i
];

const URL_KEY_PATTERNS = [
  /^url$/i,
  /^image_url$/i,
  /^attachmentUrl$/i,
  /^imageUrl$/i
];

function isSecretKey(key) {
  if (typeof key !== 'string') return false;
  return SECRET_KEY_PATTERNS.some(pattern => pattern.test(key));
}

function isUrlKey(key) {
  if (typeof key !== 'string') return false;
  return URL_KEY_PATTERNS.some(pattern => pattern.test(key));
}

function stripUrlQuery(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const queryIndex = value.indexOf('?');
    return queryIndex === -1 ? value : value.slice(0, queryIndex);
  }
}

function sanitizeValue(key, value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 8) return REDACTED;

  if (isSecretKey(key)) {
    return REDACTED;
  }

  if (isUrlKey(key) && typeof value === 'string') {
    return stripUrlQuery(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(key, item, depth + 1));
  }

  if (typeof value === 'object') {
    return sanitizeLogMeta(value, depth + 1);
  }

  return value;
}

/**
 * Deep-clones log metadata and redacts secret-bearing keys and URL query strings.
 * @param {object} meta
 * @param {number} [depth]
 * @returns {object|undefined|null}
 */
function sanitizeLogMeta(meta, depth = 0) {
  if (meta === null || meta === undefined) return meta;
  if (typeof meta !== 'object') return meta;
  if (depth > 8) return { truncated: true };

  if (Array.isArray(meta)) {
    return meta.map(item => sanitizeValue('', item, depth + 1));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.stack === 'string' && typeof value.message === 'string') {
      sanitized[key] = serializeError(value, { includeStack: key === 'error' && depth === 0 });
      continue;
    }
    sanitized[key] = sanitizeValue(key, value, depth + 1);
  }
  return sanitized;
}

/**
 * @param {Error|*} err
 * @param {{ includeStack?: boolean }} [options]
 * @returns {{ errorName?: string, errorMessage?: string, httpStatus?: number, stack?: string }}
 */
function serializeError(err, options = {}) {
  if (!err) return {};
  const includeStack = options.includeStack === true;
  const httpStatus = err?.status || err?.statusCode || err?.httpStatus;
  const serialized = {
    errorName: err?.name || 'Error',
    errorMessage: err?.message || String(err)
  };
  if (httpStatus !== undefined && httpStatus !== null) {
    serialized.httpStatus = httpStatus;
  }
  if (includeStack && typeof err?.stack === 'string') {
    serialized.stack = err.stack.split('\n').slice(0, 8).join('\n');
  }
  return serialized;
}

/**
 * @param {{ id?: string, filename?: string, name?: string, contentType?: string, url?: string }} attachment
 * @returns {string}
 */
function safeAttachmentLabel(attachment) {
  if (!attachment || typeof attachment !== 'object') return 'attachment';
  if (attachment.id) return `attachment:${attachment.id}`;
  if (attachment.filename) return `file:${attachment.filename}`;
  if (attachment.name) return `file:${attachment.name}`;
  if (attachment.contentType) return `media:${attachment.contentType}`;
  return 'attachment';
}

module.exports = {
  REDACTED,
  sanitizeLogMeta,
  serializeError,
  safeAttachmentLabel,
  stripUrlQuery
};
