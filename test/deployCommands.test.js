const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

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
