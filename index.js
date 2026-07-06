const path = require('path');
const config = require('./config');
const deployCommands = require('./deploy-commands');
const logger = require('./logger')(path.basename(__filename));

const { discordShardCount } = config;

async function start() {
  try {
    await deployCommands();
    logger.info('Slash commands deployed on startup.');
  } catch (error) {
    logger.error('Failed to deploy slash commands on startup.', {
      errorMessage: error?.message,
      outcome: 'error'
    });
    process.exit(1);
  }

  if (discordShardCount && discordShardCount !== 1) {
    const { ShardingManager } = require('discord.js');
    const manager = new ShardingManager(path.join(__dirname, 'bot.js'), {
      token: config.token,
      totalShards: discordShardCount,
      respawn: true
    });

    manager.on('shardCreate', shard => {
      logger.info('Launched Discord shard.', { shardId: shard.id, shardCount: discordShardCount });
    });

    manager.spawn().catch(error => {
      logger.error('Failed to spawn Discord shards.', {
        shardCount: discordShardCount,
        errorMessage: error?.message,
        outcome: 'error'
      });
      process.exit(1);
    });
  } else {
    require('./bot.js');
  }
}

start().catch(error => {
  logger.error('Failed to start bot.', {
    errorMessage: error?.message,
    outcome: 'error'
  });
  process.exit(1);
});
