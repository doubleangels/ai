const defaultExports = {
  Client: class {
    constructor() {
      this.on = () => {};
      this.once = () => {};
    }
  },
  Collection: class extends Map {},
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  ActivityType: { Watching: 3 },
  Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' },
  SlashCommandBuilder: class {
    constructor() { this._data = {}; }
    setName() { return this; }
    setDescription() { return this; }
    setDefaultMemberPermissions() { return this; }
    addChannelOption(cb) {
      const option = {
        setName: () => option,
        setDescription: () => option,
        addChannelTypes: () => option,
        setRequired: () => option
      };
      try { cb(option); } catch (_) {}
      return this;
    }
    toJSON() { return this._data; }
  },
  EmbedBuilder: class {
    constructor() { this.data = {}; }
    setColor(c) { this.data.color = c; return this; }
    setTitle(t) { this.data.title = t; return this; }
    setDescription(d) { this.data.description = d; return this; }
  },
  ChannelType: { GuildText: 0 },
  PermissionFlagsBits: { Administrator: 0 },
  REST: class {
    constructor() {}
    setToken() { return this; }
    async put() { return { ok: true }; }
  },
  Routes: { applicationCommands: id => `/applications/${id}/commands` },
  Options: {
    cacheWithLimits: limits => limits,
    DefaultMakeCacheSettings: {}
  }
};

module.exports = global.__discordStub || defaultExports;
