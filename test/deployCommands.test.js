const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('node:child_process');

function stubDiscord(restBehavior = { succeed: true }) {
  try {
    const discordPath = require.resolve('discord.js');
    const fake = {
      // Minimal builders used by command files
      SlashCommandBuilder: class {
        constructor() { this._data = {}; }
        setName() { return this; }
        setDescription() { return this; }
        setDefaultMemberPermissions() { return this; }
        addChannelOption(cb) { return this; }
        toJSON() { return this._data; }
      },
      EmbedBuilder: class {
        constructor() { this._e = {}; }
        setColor() { return this; }
        setTitle() { return this; }
        setDescription() { return this; }
      },
      ChannelType: { GuildText: 0 },
      PermissionFlagsBits: { Administrator: 0 },
      REST: class {
        constructor() {}
        setToken() { return this; }
        async put(route, opts) {
          if (restBehavior.succeed) return { ok: true };
          const err = new Error('deploy failed');
          err.status = 500;
          throw err;
        }
      },
      Routes: { applicationCommands: (id) => `/applications/${id}/commands` }
    };
    require.cache[discordPath] = { id: discordPath, filename: discordPath, loaded: true, exports: fake };
    return discordPath;
  } catch (e) {
    return null;
  }
}

test('deployCommands succeeds when REST.put resolves', async () => {
  process.env.DISCORD_CLIENT_ID = 'client-1';
  stubDiscord({ succeed: true });
  delete require.cache[require.resolve('../deploy-commands')];
  const deploy = require('../deploy-commands');
  await assert.doesNotReject(async () => deploy());
});

test('deployCommands throws when REST.put rejects', async () => {
  process.env.DISCORD_CLIENT_ID = 'client-1';
  stubDiscord({ succeed: false });
  delete require.cache[require.resolve('../deploy-commands')];
  const deploy = require('../deploy-commands');
  await assert.rejects(async () => deploy());
});

// --- appended from test/deployCommands.coverage.test.js ---

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

test('deploy-commands uses config.clientId when DISCORD_CLIENT_ID env is unset at deploy time', async () => {
  const originalClientId = process.env.DISCORD_CLIENT_ID;
  delete process.env.DISCORD_CLIENT_ID;
  stubDiscord({ succeed: true });

  const configPath = require.resolve('../config');
  const baseConfig = require(configPath);
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { ...baseConfig, token: 'test-token', clientId: 'config-client-id' }
  };

  delete require.cache[require.resolve('../deploy-commands')];
  const deploy = require('../deploy-commands');

  try {
    await assert.doesNotReject(async () => deploy());
  } finally {
    if (originalClientId === undefined) {
      delete process.env.DISCORD_CLIENT_ID;
    } else {
      process.env.DISCORD_CLIENT_ID = originalClientId;
    }
    delete require.cache[configPath];
  }
});

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
