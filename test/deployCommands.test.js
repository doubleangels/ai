const path = require('path');
const fs = require('fs');
const { spawnSync } = require('node:child_process');
const { stubModule, reloadModule } = require('./testUtils.cjs');
const deployPath = path.resolve(__dirname, '..', 'deploy-commands.js');

function stubDiscord(restBehavior = { succeed: true }) {
  global.__discordStub = {
    SlashCommandBuilder: class {
      constructor() { this._data = {}; }
      setName() { return this; }
      setDescription() { return this; }
      setDefaultMemberPermissions() { return this; }
      setIntegrationTypes() { return this; }
      setContexts() { return this; }
      addChannelOption(cb) { return this; }
      toJSON() { return this._data; }
    },
    ApplicationIntegrationType: { GuildInstall: 0, UserInstall: 1 },
    InteractionContextType: { Guild: 0, BotDM: 1, PrivateChannel: 2 },
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
}

function loadDeployWithFs(files) {
  const originalReaddirSync = fs.readdirSync;
  const deploy = reloadModule(deployPath, () => {
    stubDiscord({ succeed: true });
    fs.readdirSync = () => files;
  });
  return {
    deploy,
    restore: () => {
      fs.readdirSync = originalReaddirSync;
    }
  };
}

test('should succeeds when REST.put resolves', async () => {
  process.env.DISCORD_CLIENT_ID = 'client-1';
  const deploy = reloadModule(deployPath, () => stubDiscord({ succeed: true }));
  await expect(deploy()).resolves.not.toThrow();
});

test('should throws when REST.put rejects', async () => {
  process.env.DISCORD_CLIENT_ID = 'client-1';
  const deploy = reloadModule(deployPath, () => stubDiscord({ succeed: false }));
  await expect(deploy()).rejects.toThrow();
});

test('should records httpStatus fallback metrics when REST.put rejects', async () => {
  process.env.DISCORD_CLIENT_ID = 'client-1';
  global.__discordStub = {
    SlashCommandBuilder: class {
      constructor() { this._data = {}; }
      setName() { return this; }
      setDescription() { return this; }
      setDefaultMemberPermissions() { return this; }
      setIntegrationTypes() { return this; }
      setContexts() { return this; }
      addChannelOption() { return this; }
      toJSON() { return this._data; }
    },
    ApplicationIntegrationType: { GuildInstall: 0, UserInstall: 1 },
    InteractionContextType: { Guild: 0, BotDM: 1, PrivateChannel: 2 },
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
      async put() {
        const err = new Error('forbidden');
        err.httpStatus = 418;
        throw err;
      }
    },
    Routes: { applicationCommands: (id) => `/applications/${id}/commands` }
  };

  const deploy = reloadModule(deployPath, () => {});
  await expect(deploy()).rejects.toThrow();
  delete global.__discordStub;
});

test('should throws when no command files can be loaded', async () => {
  process.env.DISCORD_CLIENT_ID = 'client-1';
  const { deploy, restore } = loadDeployWithFs(['missing.js']);
  try {
    await expect(deploy()).rejects.toThrow(/No commands could be loaded/);
  } finally {
    restore();
  }
});

test('should uses config.clientId when DISCORD_CLIENT_ID env is unset at deploy time', async () => {
  const originalClientId = process.env.DISCORD_CLIENT_ID;
  delete process.env.DISCORD_CLIENT_ID;

  const configPath = require.resolve('../config');
  const deploy = reloadModule(deployPath, () => {
    stubDiscord({ succeed: true });
    const baseConfig = require(configPath);
    stubModule(configPath, { ...baseConfig, token: 'test-token', clientId: 'config-client-id' });
  });

  try {
    await expect(deploy()).resolves.not.toThrow();
  } finally {
    if (originalClientId === undefined) {
      delete process.env.DISCORD_CLIENT_ID;
    } else {
      process.env.DISCORD_CLIENT_ID = originalClientId;
    }
  }
});

test('should main entrypoint handles failures and exits cleanly', () => {
  const preloadPath = path.resolve(__dirname, 'deployCommands.preload.cjs');
  const result = spawnSync(process.execPath, ['--require', preloadPath, path.resolve(__dirname, '..', 'deploy-commands.js')], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });

  expect(result.status).toBe(1);
});

test('should main entrypoint exits cleanly on success', () => {
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

  expect(result.status).toBe(0);
});

test('should runDeployCli handles success and failure paths', async () => {
  process.env.DISCORD_CLIENT_ID = 'client-1';
  const exitCodes = [];
  const originalExit = process.exit;
  process.exit = code => exitCodes.push(code);

  try {
    const failingDeploy = reloadModule(deployPath, () => stubDiscord({ succeed: false }));
    await failingDeploy.runDeployCli();
    expect(exitCodes).toEqual([1]);

    exitCodes.length = 0;
    const successfulDeploy = reloadModule(deployPath, () => stubDiscord({ succeed: true }));
    await successfulDeploy.runDeployCli();
    expect(exitCodes).toEqual([]);
  } finally {
    process.exit = originalExit;
  }
});
