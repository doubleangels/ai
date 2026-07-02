const { withDiscordRetry } = require('../utils/discordApi');

test('should withDiscordRetry succeeds on first attempt', async () => {
  const result = await withDiscordRetry(async () => 'ok');
  expect(result).toBe('ok');
});

test('should withDiscordRetry retries 429 responses with backoff', async () => {
  jest.useFakeTimers();
  let attempts = 0;
  const promise = withDiscordRetry(async () => {
    attempts += 1;
    if (attempts < 2) {
      const err = new Error('rate limited');
      err.status = 429;
      err.retry_after = 2;
      throw err;
    }
    return 'recovered';
  });

  await jest.advanceTimersByTimeAsync(2500);
  await expect(promise).resolves.toBe('recovered');
  expect(attempts).toBe(2);
  jest.useRealTimers();
});

test('should withDiscordRetry rethrows non-429 errors', async () => {
  await expect(withDiscordRetry(async () => {
    const err = new Error('forbidden');
    err.status = 403;
    throw err;
  })).rejects.toThrow(/forbidden/);
});

test('should withDiscordRetry honors retry_after from nested data', async () => {
  jest.useFakeTimers();
  let attempts = 0;
  const promise = withDiscordRetry(async () => {
    attempts += 1;
    if (attempts < 2) {
      const err = new Error('rate limited');
      err.httpStatus = 429;
      err.data = { retry_after: 1 };
      throw err;
    }
    return 'ok';
  });

  await jest.advanceTimersByTimeAsync(1100);
  await expect(promise).resolves.toBe('ok');
  expect(attempts).toBe(2);
  jest.useRealTimers();
});

test('should withDiscordRetry uses exponential backoff without retry_after', async () => {
  jest.useFakeTimers();
  let attempts = 0;
  const promise = withDiscordRetry(async () => {
    attempts += 1;
    if (attempts < 2) {
      const err = new Error('rate limited');
      err.statusCode = 429;
      throw err;
    }
    return 'recovered';
  }, { maxRetries: 2, baseDelayMs: 40 });

  await jest.advanceTimersByTimeAsync(50);
  await expect(promise).resolves.toBe('recovered');
  expect(attempts).toBe(2);
  jest.useRealTimers();
});

test('should withDiscordRetry logs when rate limit retries are exhausted', async () => {
  const err429 = new Error('rate limited');
  err429.status = 429;

  await expect(withDiscordRetry(async () => {
    throw err429;
  }, { maxRetries: 0 })).rejects.toThrow(/rate limited/);
});
