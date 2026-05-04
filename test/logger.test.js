const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const getLogger = require(path.resolve(__dirname, '..', 'logger.js'));

test('getLogger throws on invalid label', () => {
  assert.throws(() => getLogger(null));
});

test('getLogger returns logger with methods', () => {
  const logger = getLogger('test');
  assert.equal(typeof logger.info, 'function');
  assert.equal(typeof logger.error, 'function');
  assert.equal(typeof logger._pino, 'object');
});
