const path = require('path');

const indexPath = path.resolve(__dirname, '..', 'index.js');
const configPath = path.resolve(__dirname, '..', 'config.js');
const botPath = path.resolve(__dirname, '..', 'bot.js');
const deployPath = path.resolve(__dirname, '..', 'deploy-commands.js');

function mockDeployResolved() {
  jest.doMock(deployPath, () => jest.fn().mockResolvedValue(undefined));
}

test('should index requires bot when sharding is disabled', async () => {
  let botLoaded = false;
  jest.isolateModules(() => {
    mockDeployResolved();
    jest.doMock(configPath, () => ({ discordShardCount: 0, token: 'fake-token' }));
    jest.doMock(botPath, () => { botLoaded = true; });
    require(indexPath);
  });
  await Promise.resolve();
  expect(botLoaded).toBe(true);
});

test('should index spawns ShardingManager when shard count is configured', async () => {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  const spawn = jest.fn().mockResolvedValue(undefined);
  jest.isolateModules(() => {
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
  expect(logSpy).toHaveBeenCalled();
  logSpy.mockRestore();
});

test('should index exits when shard spawn fails', async () => {
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const spawn = jest.fn().mockRejectedValue(new Error('spawn failed'));

  jest.isolateModules(() => {
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
  exitSpy.mockRestore();
  errorSpy.mockRestore();
});

test('should index exits when command deploy fails on startup', async () => {
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  jest.isolateModules(() => {
    jest.doMock(deployPath, () => jest.fn().mockRejectedValue(new Error('deploy failed')));
    jest.doMock(configPath, () => ({ discordShardCount: 0, token: 'fake-token' }));
    jest.doMock(botPath, () => {});
    require(indexPath);
  });

  await Promise.resolve();
  expect(exitSpy).toHaveBeenCalledWith(1);
  exitSpy.mockRestore();
  errorSpy.mockRestore();
});
