const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const instrument = require(path.resolve(__dirname, '..', 'instrument.js'));

test('captureError returns the error object', () => {
  const err = new Error('boom');
  const res = instrument.captureError(err, { foo: 'bar' });
  assert.equal(res, err);
});

test('startSpan executes callback and returns its value', async () => {
  const val = await instrument.startSpan({ op: 'test' }, async () => {
    return 42;
  });
  assert.equal(val, 42);
});

test('recordCount does not throw', () => {
  assert.doesNotThrow(() => instrument.recordCount('test.metric', 1, { a: 1 }));
});
