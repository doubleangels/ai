const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./logger')(path.basename(__filename));
const config = require('./config');

/**
 * Deploys slash commands to Discord.
 * Loads all command files from the commands directory and registers them with Discord.
 * 
 * @returns {Promise<void>} A promise that resolves when commands are deployed
 * @throws {Error} If command deployment fails
 */
async function deployCommands() {
  const commands = [];
  
  const commandsPath = path.join(__dirname, 'commands');
  
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
  
  for (const file of commandFiles) {
    try {
      const command = require(`./commands/${file}`);
      commands.push(command.data.toJSON());
      logger.debug(`Loaded command: ${file}`);
    } catch (err) {
      logger.error(`Failed to load command file: ${file}, skipping.`, {
        error: err?.stack,
        message: err?.message
      });
    }
  }

  if (commands.length === 0) {
    throw new Error('No commands could be loaded. Check the errors above.');
  }
  
  const rest = new REST({ version: '10' }).setToken(config.token);
  
  const clientId = process.env.DISCORD_CLIENT_ID || config.clientId;
  logger.info(`Deploying commands for application ID: ${clientId}`);
  
  try {    
    await rest.put(
      Routes.applicationCommands(clientId), 
      { body: commands }
    );
    
    logger.info(`Successfully registered ${commands.length} application (/) commands.`);
  } catch (error) {
    logger.error('Failed to deploy commands.', {
      error: error?.stack,
      message: error?.message
    });
    throw error;
  }
}

module.exports = deployCommands;

if (require.main === module) {
  deployCommands()
    .then(() => logger.info('Command deployment completed successfully.'))
    .catch(err => {
      logger.error('Failed to deploy commands.', {
        error: err?.stack,
        message: err?.message
      });
      process.exit(1);
    });
}