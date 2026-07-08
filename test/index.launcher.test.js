const path = require('path');

const indexPath = path.resolve(__dirname, '..', 'index.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const botPath = path.resolve(__dirname, '..', 'bot.js');
const deployPath = path.resolve(__dirname, '..', 'deploy-commands.js');
const loggerPath = path.resolve(__dirname, '..', 'logger.js');

function mockDeployResolved() {
  jest.doMock(deployPath, () => jest.fn().mockResolvedValue(undefined));
}

function mockLogger() {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  jest.doMock(loggerPath, () => () => logger);
  return logger;
}

test('should index requires bot when sharding is disabled', async () => {
  let botLoaded = false;
  jest.isolateModules(() => {
    mockLogger();
    mockDeployResolved();
    jest.doMock(configPath, () => ({ discordShardCount: 0, token: 'fake-token' }));
    jest.doMock(botPath, () => { botLoaded = true; });
    require(indexPath);
  });
  await Promise.resolve();
  expect(botLoaded).toBe(true);
});

test('should index spawns ShardingManager when shard count is configured', async () => {
  let logger;
  const spawn = jest.fn().mockResolvedValue(undefined);
  jest.isolateModules(() => {
    logger = mockLogger();
    mockDeployResolved();
    jest.doMock(configPath, () => ({ discordShardCount: 2, token: 'fake-token' }));
    jest.doMock('discord.js', () => ({
      ShardingManager: class {
        constructor(worker, opts) {
          this.worker = worker;
          this.opts = opts;
        }
        on(_event, handler) {
          if (_event === 'shardCreate') handler({ id: 0 });
          return this;
        }
        spawn() { return spawn(); }
      }
    }));
    require(indexPath);
  });
  await Promise.resolve();
  expect(spawn).toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith(
    'Launched Discord shard.',
    expect.objectContaining({ shardId: 0, shardCount: 2 })
  );
});

test('should index exits when shard spawn fails', async () => {
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  let logger;
  const spawn = jest.fn().mockRejectedValue(new Error('spawn failed'));

  jest.isolateModules(() => {
    logger = mockLogger();
    mockDeployResolved();
    jest.doMock(configPath, () => ({ discordShardCount: 2, token: 'fake-token' }));
    jest.doMock('discord.js', () => ({
      ShardingManager: class {
        constructor() {}
        on() { return this; }
        spawn() { return spawn(); }
      }
    }));
    require(indexPath);
  });

  await Promise.resolve();
  await Promise.resolve();
  expect(spawn).toHaveBeenCalled();
  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(logger.error).toHaveBeenCalledWith(
    'Failed to spawn Discord shards.',
    expect.objectContaining({ outcome: 'error' })
  );
  exitSpy.mockRestore();
});

test('should index logs and exits when start fails to boot the bot', async () => {
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  let logger;

  jest.isolateModules(() => {
    logger = mockLogger();
    mockDeployResolved();
    jest.doMock(configPath, () => ({ discordShardCount: 0, token: 'fake-token' }));
    jest.doMock(botPath, () => { throw new Error('bot boom'); });
    require(indexPath);
  });

  await Promise.resolve();
  await Promise.resolve();
  expect(logger.error).toHaveBeenCalledWith(
    'Failed to start bot.',
    expect.objectContaining({ outcome: 'error' })
  );
  expect(exitSpy).toHaveBeenCalledWith(1);
  exitSpy.mockRestore();
});

test('should index exits when command deploy fails on startup', async () => {
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  let logger;

  jest.isolateModules(() => {
    logger = mockLogger();
    jest.doMock(deployPath, () => jest.fn().mockRejectedValue(new Error('deploy failed')));
    jest.doMock(configPath, () => ({ discordShardCount: 0, token: 'fake-token' }));
    jest.doMock(botPath, () => {});
    require(indexPath);
  });

  await Promise.resolve();
  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(logger.error).toHaveBeenCalledWith(
    'Failed to deploy slash commands on startup.',
    expect.objectContaining({ outcome: 'error' })
  );
  exitSpy.mockRestore();
});
