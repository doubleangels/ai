const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config.js');
const instrumentPath = path.join(root, 'instrument.js');
const loggerPath = path.join(root, 'logger.js');
const discordPath = require.resolve('discord.js');
const shouldSucceed = process.env.DEPLOY_COMMANDS_PRELOAD_MODE === 'success';

require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: {
    token: 'fake-token',
    clientId: 'client-1'
  }
};

require.cache[instrumentPath] = {
  id: instrumentPath,
  filename: instrumentPath,
  loaded: true,
  exports: {
    Sentry: { isEnabled: () => false },
    captureError: () => {},
    recordCount: () => {},
    recordDistribution: () => {},
    startSpan: async (_options, callback) => callback()
  }
};

require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    fatal() {}
  })
};

require.cache[discordPath] = {
  id: discordPath,
  filename: discordPath,
  loaded: true,
  exports: {
    REST: class {
      setToken() { return this; }
      async put() {
        if (shouldSucceed) return { ok: true };
        throw new Error('deploy failed');
      }
    },
    Routes: {
      applicationCommands: () => '/applications/client-1/commands'
    },
    SlashCommandBuilder: class {
      constructor() { this.name = 'reset'; }
      setName(value) { this.name = value; return this; }
      setDescription() { return this; }
      setDefaultMemberPermissions() { return this; }
      setIntegrationTypes() { return this; }
      setContexts() { return this; }
      addChannelOption() { return this; }
      toJSON() { return { name: this.name }; }
    },
    ApplicationIntegrationType: { GuildInstall: 0, UserInstall: 1 },
    InteractionContextType: { Guild: 0, BotDM: 1, PrivateChannel: 2 },
    EmbedBuilder: class {},
    ChannelType: { GuildText: 0 },
    PermissionFlagsBits: { Administrator: 1 }
  }
};

const originalReaddirSync = fs.readdirSync;
fs.readdirSync = directory => {
  if (directory.endsWith(path.sep + 'commands')) {
    return shouldSucceed ? ['reset.js'] : ['missing.js'];
  }
  return originalReaddirSync(directory);
};