const { captureError, closeSentry, recordCount, recordDistribution, startSpan } = require('./instrument');
const { Client, Collection, GatewayIntentBits, Options, ActivityType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./logger')(path.basename(__filename));
const config = require('./config');

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
  presence: {
    activities: [{ name: 'for mentions! 📢', type: ActivityType.Watching }],
    status: 'online',
  },
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

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  try {
    const command = require(path.join(commandsPath, file));
    client.commands.set(command.data.name, command);
    logger.info(`Loaded command ${command.data.name}.`);
  } catch (error) {
    logger.error(`Error occurred while loading command file ${file}.`, {
      error: error.stack,
      message: error.message
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
            logger.error(`Error executing once event ${event.name}.`, {
              error: error.stack,
              message: error.message
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
            logger.error(`Error executing event ${event.name}.`, {
              error: error.stack,
              message: error.message
            });
          });
      });
    }
    logger.info(`Loaded event ${event.name}.`);
  } catch (error) {
    logger.error(`Error occurred while loading event file ${file}.`, {
      error: error.stack,
      message: error.message
    });
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  if (!interactionAllowedInGuild(interaction)) {
    try {
      await interaction.reply({ content: 'This bot is not enabled in this server.', ephemeral: true });
    } catch (_) {
      /* ignore */
    }
    return;
  }

  const startedAt = Date.now();

  try {
    logger.debug(`Executing command ${interaction.commandName}.`, { 
      user: interaction.user.tag,
      userId: interaction.user.id,
      guildId: interaction.guildId
    });
    await startSpan({
      op: 'discord.command',
      name: `/${interaction.commandName}`
    }, async () => {
      await command.execute(interaction);
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
    logger.error(`Error executing command ${interaction.commandName}.`, {
      error: error.stack,
      message: error.message,
      user: interaction.user.tag
    });
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: '⚠️ There was an error executing that command!', ephemeral: true });
      } else {
        await interaction.reply({ content: '⚠️ There was an error executing that command!', ephemeral: true });
      }
    } catch (replyError) {
      logger.error('Error sending error response.', {
        error: replyError?.stack,
        message: replyError?.message,
        originalError: error.message
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

client.on('interactionCreate', async interaction => {
  if (!interaction.isContextMenuCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    logger.warn(`Unknown context menu command ${interaction.commandName}.`);
    return;
  }

  if (!interactionAllowedInGuild(interaction)) {
    try {
      await interaction.reply({ content: 'This bot is not enabled in this server.', ephemeral: true });
    } catch (_) {
      /* ignore */
    }
    return;
  }

  logger.debug(`Executing context menu command ${interaction.commandName}.`, { 
    user: interaction.user.tag,
    userId: interaction.user.id,
    guildId: interaction.guildId
  });

  const startedAt = Date.now();
  try {
    await startSpan({
      op: 'discord.context_menu',
      name: interaction.commandName
    }, async () => {
      await command.execute(interaction);
    });
    recordCount('discord.context_menu.executed', 1, {
      command: interaction.commandName,
      outcome: 'success'
    });
    recordDistribution('discord.context_menu.duration_ms', Date.now() - startedAt, {
      unit: 'millisecond',
      attributes: {
        command: interaction.commandName,
        outcome: 'success'
      }
    });
    logger.debug(`Context menu command ${interaction.commandName} executed successfully.`);
  } catch (error) {
    captureError(error, { source: 'contextMenuExecute', command: interaction.commandName });
    recordCount('discord.context_menu.executed', 1, {
      command: interaction.commandName,
      outcome: 'error'
    });
    recordDistribution('discord.context_menu.duration_ms', Date.now() - startedAt, {
      unit: 'millisecond',
      attributes: {
        command: interaction.commandName,
        outcome: 'error'
      }
    });
    logger.error(`Error executing context menu command ${interaction.commandName}.`, { 
      error: error.stack,
      message: error.message,
      user: interaction.user.tag
    });

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: '⚠️ There was an error executing that command!', ephemeral: true });
      } else {
        await interaction.reply({ content: '⚠️ There was an error executing that command!', ephemeral: true });
      }
    } catch (replyError) {
      logger.error('Error sending error response.', {
        error: replyError?.stack,
        message: replyError?.message,
        originalError: error.message
      });
      try {
        const httpStatus = replyError?.status || replyError?.statusCode || replyError?.httpStatus;
        recordCount('discord.api.failure', 1, {
          location: 'index.contextmenu_reply',
          command: interaction.commandName,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          errorMessage: replyError?.message,
          httpStatus
        });
        if (httpStatus === 429) {
          recordCount('discord.api.rate_limit', 1, {
            location: 'index.contextmenu_reply',
            command: interaction.commandName,
            guildId: interaction.guildId
          });
        }
      } catch (metricErr) {
        logger.debug('Failed to record discord.api.failure metric for context menu reply.', { errorMessage: metricErr.message });
      }
    }
  }
});

startSpan({
  op: 'discord.login',
  name: 'Discord client login'
}, async () => client.login(config.token)).catch(error => {
  captureError(error, { source: 'clientLogin' });
  recordCount('discord.login', 1, {
    outcome: 'error'
  });
  logger.error('Error logging in.', {
    error: error.stack,
    message: error.message
  });
});

process.on('uncaughtException', (error) => {
  captureError(error, { handler: 'uncaughtException' });
  logger.error('Uncaught Exception.', {
    error: error.stack,
    message: error.message
  });
  closeSentry().finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  captureError(error, { handler: 'unhandledRejection' });
  logger.error('Unhandled Promise Rejection.', {
    error: error.stack,
    message: error.message
  });
  closeSentry().finally(() => process.exit(1));
});

process.on('SIGINT', async () => {
  logger.info('Shutdown signal (SIGINT) received. Exiting...');
  try {
    await closeSentry();
  } catch (err) {
    logger.error('Error flushing Sentry on shutdown.', {
      error: err.stack,
      message: err.message
    });
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutdown signal (SIGTERM) received. Exiting...');
  try {
    await closeSentry();
  } catch (err) {
    logger.error('Error flushing Sentry on shutdown.', {
      error: err.stack,
      message: err.message
    });
  }
  process.exit(0);
});