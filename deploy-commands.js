const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { captureError, recordCount, recordDistribution, startSpan } = require('./instrument');
const logger = require('./logger')(path.basename(__filename));
const config = require('./config');
const { serializeError } = require('./utils/logSanitize');

/**
 * Deploys slash commands to Discord.
 * Loads all command files from the commands directory and registers them with Discord.
 * 
 * @returns {Promise<void>} A promise that resolves when commands are deployed
 * @throws {Error} If command deployment fails
 */
async function deployCommands() {
  const commands = [];
  const startedAt = Date.now();
  
  const commandsPath = path.join(__dirname, 'commands');
  
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

  await startSpan({
    op: 'discord.deploy_commands',
    name: 'Deploy slash commands'
  }, async () => {
    for (const file of commandFiles) {
      try {
        const command = require(`./commands/${file}`);
        commands.push(command.data.toJSON());
        logger.debug(`Loaded command ${file}.`);
      } catch (err) {
        captureError(err, { source: 'deployCommands', handler: 'commandLoad', file });
        logger.error('Failed to load command file; skipping.', {
          file,
          ...serializeError(err, { includeStack: true })
        });
      }
    }
  });

  if (commands.length === 0) {
    throw new Error('No commands could be loaded. Check the errors above.');
  }
  
  const rest = new REST({ version: '10' }).setToken(config.token);
  
  const clientId = process.env.DISCORD_CLIENT_ID || config.clientId;
  logger.info('Deploying slash commands.', { clientId, commandCount: commands.length });

  try {
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );

    const durationMs = Date.now() - startedAt;
    logger.info('Successfully registered application commands.', {
      clientId,
      commandCount: commands.length,
      durationMs,
      outcome: 'success'
    });
    recordCount('discord.deploy_commands', 1, {
      outcome: 'success'
    });
    recordDistribution('discord.deploy_commands.duration_ms', Date.now() - startedAt, {
      unit: 'millisecond',
      attributes: {
        outcome: 'success'
      }
    });
  } catch (error) {
    captureError(error, { source: 'deployCommands', handler: 'registerCommands' });
    recordCount('discord.deploy_commands', 1, {
      outcome: 'error'
    });
    recordDistribution('discord.deploy_commands.duration_ms', Date.now() - startedAt, {
      unit: 'millisecond',
      attributes: {
        outcome: 'error'
      }
    });
    logger.error('Failed to deploy commands.', {
      clientId,
      commandCount: commands.length,
      durationMs: Date.now() - startedAt,
      outcome: 'error',
      ...serializeError(error, { includeStack: true })
    });
    try {
      const httpStatus = error?.status || error?.statusCode || error?.httpStatus;
      recordCount('discord.api.failure', 1, {
        location: 'deploy.register',
        errorMessage: error?.message,
        httpStatus
      });
      if (httpStatus === 429) {
        recordCount('discord.api.rate_limit', 1, {
          location: 'deploy.register'
        });
      }
    } catch (metricErr) {
      logger.debug('Failed to record discord.api.failure metric during deploy.', { errorMessage: metricErr.message });
    }
    throw error;
  }
}

module.exports = deployCommands;

function runDeployCli() {
  return deployCommands()
    .then(() => logger.info('Command deployment completed successfully.'))
    .catch(err => {
      captureError(err, { source: 'deployCommands', handler: 'main' });
      logger.error('Failed to deploy commands.', serializeError(err, { includeStack: true }));
      process.exit(1);
    });
}

module.exports.runDeployCli = runDeployCli;

/* v8 ignore start */
if (require.main === module) {
  runDeployCli();
}
/* v8 ignore stop */