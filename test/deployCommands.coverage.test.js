const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const deployPath = path.resolve(__dirname, '..', 'deploy-commands.js');

function loadDeployWithFs(files) {
  delete require.cache[deployPath];
  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = () => files;
  return {
    deploy: require(deployPath),
    restore: () => {
      fs.readdirSync = originalReaddirSync;
    }
  };
}

test('deploy-commands throws when no command files can be loaded', async () => {
  process.env.DISCORD_CLIENT_ID = 'client-1';
  const { deploy, restore } = loadDeployWithFs(['missing.js']);
  try {
    await assert.rejects(async () => deploy(), /No commands could be loaded/);
  } finally {
    restore();
  }
});