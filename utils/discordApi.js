/**
 * Runs a Discord API call with exponential backoff on HTTP 429 rate limits.
 * @param {() => Promise<*>} fn
 * @param {{ maxRetries?: number, baseDelayMs?: number, label?: string }} [options]
 * @returns {Promise<*>}
 */
async function withDiscordRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const label = options.label || 'discord_api';

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const httpStatus = error?.status || error?.statusCode || error?.httpStatus;
      if (httpStatus !== 429 || attempt >= maxRetries) {
        throw error;
      }

      const retryAfterSec = Number(error?.retry_after ?? error?.data?.retry_after);
      const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : baseDelayMs * (2 ** attempt);

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

module.exports = { withDiscordRetry };
