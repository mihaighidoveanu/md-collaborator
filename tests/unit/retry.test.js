const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withRetry } = require('../../server/lib/retry');

test('withRetry returns the result on first success without retrying', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; }, { baseDelayMs: 1 });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry recovers when an early attempt fails then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('blip');
    return 'recovered';
  }, { attempts: 3, baseDelayMs: 1 });
  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
});

test('withRetry throws the last error after exhausting all attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new Error(`fail ${calls}`); }, { attempts: 3, baseDelayMs: 1 }),
    /fail 3/
  );
  assert.equal(calls, 3);
});
