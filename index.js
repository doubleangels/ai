const path = require('path');
const config = require('./config');

const { discordShardCount } = config;

if (discordShardCount && discordShardCount !== 1) {
  const { ShardingManager } = require('discord.js');
  const manager = new ShardingManager(path.join(__dirname, 'bot.js'), {
    token: config.token,
    totalShards: discordShardCount,
    respawn: true
  });

  manager.on('shardCreate', shard => {
    console.log(`Launched Discord shard ${shard.id}.`);
  });

  manager.spawn().catch(error => {
    console.error('Failed to spawn Discord shards.', error);
    process.exit(1);
  });
} else {
  require('./bot.js');
}
