const { captureError, closeSentry, recordCount, recordDistribution, startSpan } = require('./instrument');
const { Client, Collection, GatewayIntentBits, MessageFlags, Options } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./logger')(path.basename(__filename));
const config = require('./config');
const { serializeError } = require('./utils/logSanitize');

function interactionAllowedInGuild(interaction) {
  const ids = config.allowedGuildIds;
  if (!ids || ids.size === 0) return true;
  if (!interaction.inGuild() || !interaction.guildId) return false;
  return ids.has(interaction.guildId);
}

/**
 * Discord client instance with required intents and memory-optimized caches
 * @type {Client}
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 50,
    ThreadManager: 20,
    VoiceStateManager: 0,
    ReactionManager: 0,
    GuildMemberManager: {
      maxSize: 50,
      keepOverLimit: member => member.id === client.user?.id,
    },
    UserManager: {
      maxSize: 50,
      keepOverLimit: user => user.id === client.user?.id,
    }
  }),
});

client.commands = new Collection();
client.conversationHistory = new Map();
client.channelLocks = new Map();
client.channelGuildIds = new Map();
client.discordReady = false;

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  try {
    const command = require(path.join(commandsPath, file));
    client.commands.set(command.data.name, command);
    logger.info(`Loaded command ${command.data.name}.`);
  } catch (error) {
    logger.error('Error occurred while loading command file.', {
      file,
      ...serializeError(error, { includeStack: true })
    });
  }
}

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
  try {
    const event = require(path.join(eventsPath, file));
    if (event.once) {
      client.once(event.name, (...args) => {
        logger.debug(`Executing ${event.name} event.`);
        Promise.resolve()
          .then(() => event.execute(...args, client))
          .catch(error => {
            captureError(error, { event: event.name, source: 'eventExecute' });
            logger.error('Error executing once event.', {
              event: event.name,
              ...serializeError(error, { includeStack: true })
            });
          });
      });
    } else {
      client.on(event.name, (...args) => {
        logger.debug(`Executing ${event.name} event.`);
        Promise.resolve()
          .then(() => event.execute(...args, client))
          .catch(error => {
            captureError(error, { event: event.name, source: 'eventExecute' });
            logger.error('Error executing event.', {
              event: event.name,
              ...serializeError(error, { includeStack: true })
            });
          });
      });
    }
    logger.info(`Loaded event ${event.name}.`);
  } catch (error) {
    logger.error('Error occurred while loading event file.', {
      file,
      ...serializeError(error, { includeStack: true })
    });
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    logger.debug('Ignoring unknown slash command.', {
      command: interaction.commandName,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      interactionId: interaction.id
    });
    return;
  }

  if (!interactionAllowedInGuild(interaction)) {
    logger.debug('Ignoring slash command from disallowed guild.', {
      command: interaction.commandName,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      interactionId: interaction.id
    });
    try {
      await interaction.reply({ content: 'This bot is not enabled in this server.', flags: MessageFlags.Ephemeral });
    } catch (_) {
      /* ignore */
    }
    return;
  }

  const startedAt = Date.now();

  try {
    logger.debug('Executing command.', {
      command: interaction.commandName,
      user: interaction.user.tag,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      interactionId: interaction.id
    });
    await startSpan({
      op: 'discord.command',
      name: `/${interaction.commandName}`
    }, async () => {
      await command.execute(interaction);
    });
    logger.info('Command executed successfully.', {
      command: interaction.commandName,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      interactionId: interaction.id,
      durationMs: Date.now() - startedAt,
      outcome: 'success'
    });
    recordCount('discord.command.executed', 1, {
      command: interaction.commandName,
      outcome: 'success'
    });
    recordDistribution('discord.command.duration_ms', Date.now() - startedAt, {
      unit: 'millisecond',
      attributes: {
        command: interaction.commandName,
        outcome: 'success'
      }
    });
  } catch (error) {
    captureError(error, { source: 'commandExecute', command: interaction.commandName });
    recordCount('discord.command.executed', 1, {
      command: interaction.commandName,
      outcome: 'error'
    });
    recordDistribution('discord.command.duration_ms', Date.now() - startedAt, {
      unit: 'millisecond',
      attributes: {
        command: interaction.commandName,
        outcome: 'error'
      }
    });
    logger.error('Error executing command.', {
      command: interaction.commandName,
      user: interaction.user.tag,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      interactionId: interaction.id,
      durationMs: Date.now() - startedAt,
      outcome: 'error',
      ...serializeError(error, { includeStack: true })
    });
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: '⚠️ There was an error executing that command!', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: '⚠️ There was an error executing that command!', flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      logger.error('Error sending error response.', {
        command: interaction.commandName,
        interactionId: interaction.id,
        guildId: interaction.guildId,
        ...serializeError(replyError, { includeStack: true }),
        originalErrorMessage: error.message
      });
      try {
        const httpStatus = replyError?.status || replyError?.statusCode || replyError?.httpStatus;
        recordCount('discord.api.failure', 1, {
          location: 'index.command_reply',
          command: interaction.commandName,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          errorMessage: replyError?.message,
          httpStatus
        });
        if (httpStatus === 429) {
          recordCount('discord.api.rate_limit', 1, {
            location: 'index.command_reply',
            command: interaction.commandName,
            guildId: interaction.guildId
          });
        }
      } catch (metricErr) {
        logger.debug('Failed to record discord.api.failure metric for command reply.', { errorMessage: metricErr.message });
      }
    }
  }
});


client.on('error', (error) => {
  captureError(error, { source: 'discordClient', handler: 'error' });
  logger.error('Discord client error.', serializeError(error, { includeStack: true }));
});

client.on('shardDisconnect', (_event, shardId) => {
  client.discordReady = false;
  logger.warn('Discord shard disconnected.', {
    shardId,
    shardCount: client.shard?.count ?? 1
  });
  recordCount('discord.gateway', 1, { outcome: 'disconnect', shardId });
});

client.on('shardError', (error, shardId) => {
  captureError(error, { source: 'discordClient', handler: 'shardError', shardId });
  logger.error('Discord shard error.', {
    shardId,
    shardCount: client.shard?.count ?? 1,
    ...serializeError(error, { includeStack: true })
  });
});

client.on('invalidated', () => {
  client.discordReady = false;
  logger.error('Discord session invalidated. Exiting.');
  recordCount('discord.gateway', 1, { outcome: 'invalidated' });
  shutdown(1);
});

async function shutdown(exitCode = 0) {
  try {
    await client.destroy();
  } catch (err) {
    logger.warn('Error destroying Discord client during shutdown.', { errorMessage: err?.message });
  }
  try {
    await closeSentry();
  } catch (err) {
    logger.error('Error flushing Sentry on shutdown.', serializeError(err, { includeStack: true }));
  }
  process.exit(exitCode);
}

startSpan({
  op: 'discord.login',
  name: 'Discord client login'
}, async () => client.login(config.token)).catch(error => {
  captureError(error, { source: 'clientLogin' });
  recordCount('discord.login', 1, {
    outcome: 'error'
  });
  logger.error('Error logging in.', serializeError(error, { includeStack: true }));
  closeSentry().finally(() => process.exit(1));
});

process.on('uncaughtException', (error) => {
  captureError(error, { handler: 'uncaughtException' });
  logger.error('Uncaught Exception.', serializeError(error, { includeStack: true }));
  closeSentry().finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  captureError(error, { handler: 'unhandledRejection' });
  logger.error('Unhandled Promise Rejection.', serializeError(error, { includeStack: true }));
  closeSentry().finally(() => process.exit(1));
});

process.on('SIGINT', () => {
  logger.info('Shutdown signal (SIGINT) received. Exiting...');
  shutdown(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutdown signal (SIGTERM) received. Exiting...');
  shutdown(0);
});