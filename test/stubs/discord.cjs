const defaultExports = {
  Client: class {
    constructor() {
      this.on = () => {};
      this.once = () => {};
    }
  },
  Collection: class extends Map {},
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  MessageFlags: { Ephemeral: 64 },
  ActivityType: { Watching: 3 },
  Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' },
  SlashCommandBuilder: class {
    constructor() { this._data = { name: '', description: '', options: [] }; }
    setName(name) { this._data.name = name; return this; }
    setDescription(description) { this._data.description = description; return this; }
    setDefaultMemberPermissions() { return this; }
    setIntegrationTypes(...types) { this._data.integration_types = types; return this; }
    setContexts(...contexts) { this._data.contexts = contexts; return this; }
    addStringOption(cb) {
      const option = {
        type: 3,
        name: '',
        description: '',
        required: false,
        choices: [],
        setName(name) { option.name = name; return option; },
        setDescription(desc) { option.description = desc; return option; },
        setRequired(required) { option.required = required; return option; },
        setMaxLength() { return option; },
        addChoices(...choices) {
          option.choices.push(...choices);
          return option;
        }
      };
      try { cb(option); } catch (_) {}
      this._data.options.push(option);
      return this;
    }
    addAttachmentOption(cb) {
      const option = {
        type: 11,
        name: '',
        description: '',
        required: false,
        setName(name) { option.name = name; return option; },
        setDescription(desc) { option.description = desc; return option; },
        setRequired(required) { option.required = required; return option; }
      };
      try { cb(option); } catch (_) {}
      this._data.options.push(option);
      return this;
    }
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
    toJSON() {
      return {
        name: this._data.name,
        description: this._data.description,
        integration_types: this._data.integration_types,
        contexts: this._data.contexts,
        options: this._data.options.map(o => ({
          name: o.name,
          description: o.description,
          type: o.type,
          required: o.required,
          choices: o.choices
        }))
      };
    }
  },
  ApplicationIntegrationType: { GuildInstall: 0, UserInstall: 1 },
  InteractionContextType: { Guild: 0, BotDM: 1, PrivateChannel: 2 },
  AttachmentBuilder: class {
    constructor(data, meta = {}) {
      this.data = data;
      this.name = meta.name;
    }
  },
  EmbedBuilder: class {
    constructor() { this.data = {}; }
    setColor(c) { this.data.color = c; return this; }
    setTitle(t) { this.data.title = t; return this; }
    setDescription(d) { this.data.description = d; return this; }
    addFields(...fields) {
      this.data.fields = [...(this.data.fields || []), ...fields];
      return this;
    }
    setFooter(footer) { this.data.footer = footer; return this; }
    setImage(image) { this.data.image = { url: image }; return this; }
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
