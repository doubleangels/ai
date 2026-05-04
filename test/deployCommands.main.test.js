const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('node:child_process');

test('deploy-commands main entrypoint handles failures and exits cleanly', () => {
  const preloadPath = path.resolve(__dirname, 'deployCommands.preload.cjs');
  const result = spawnSync(process.execPath, ['--require', preloadPath, path.resolve(__dirname, '..', 'deploy-commands.js')], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
});

test('deploy-commands main entrypoint exits cleanly on success', () => {
  const preloadPath = path.resolve(__dirname, 'deployCommands.preload.cjs');
  const result = spawnSync(
    process.execPath,
    ['--require', preloadPath, path.resolve(__dirname, '..', 'deploy-commands.js')],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPLOY_COMMANDS_PRELOAD_MODE: 'success'
      }
    }
  );

  assert.equal(result.status, 0);
});