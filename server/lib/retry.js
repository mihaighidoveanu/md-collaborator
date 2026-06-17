// Retry a flaky async operation with exponential backoff. Used for read-only
// GitHub calls (e.g. resolving the live head SHA) that can fail on a transient
// blip — a momentary network error, a 5xx, or rate-limiting — and succeed on a
// second look. Do NOT wrap write operations (creating branches, commits, or
// PRs) in this: retrying a partially-applied write risks duplicates.
async function withRetry(fn, { attempts = 3, baseDelayMs = 200 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
