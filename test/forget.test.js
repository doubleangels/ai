const path = require('path');
const { stubModule, reloadModule, defaultInstrumentStub, createMockClient } = require('./testUtils.cjs');

const forgetPath = path.resolve(__dirname, '..', 'commands', 'forget.js');
const instrumentPath = path.resolve(__dirname, '..', 'instrument.js');

function loadForgetCommand() {
  return reloadModule(forgetPath, () => {
    stubModule(instrumentPath, defaultInstrumentStub());
  });
}

function createInteraction(client) {
  const calls = [];
  const interaction = {
    user: { id: 'user-1' },
    channelId: 'dm-1',
    id: 'interaction-1',
    client,
    deferReply: async payload => { calls.push({ type: 'deferReply', payload }); },
    editReply: async payload => { calls.push({ type: 'editReply', payload }); }
  };
  return { interaction, calls };
}

test('should expose a DM-only, user-installable command', () => {
  const json = loadForgetCommand().data.toJSON();
  expect(json.name).toBe('forget');
  expect(json.integration_types).toEqual([0, 1]);
  expect(json.contexts).toEqual([1, 2]);
});

test('should clear history for the current DM after in-flight work settles', async () => {
  const command = loadForgetCommand();
  let release;
  const lock = new Promise((_resolve, reject) => { release = reject; });
  const client = createMockClient({
    conversationHistory: new Map([['dm-1', [{ role: 'system', content: 's' }]], ['other', []]]),
    channelLastActivity: new Map([['dm-1', 1]]),
    channelCooldowns: new Map([['dm-1', 1]]),
    channelLocks: new Map([['dm-1', lock]])
  });
  const { interaction, calls } = createInteraction(client);

  const run = command.execute(interaction);
  await Promise.resolve();
  expect(calls[0]).toEqual({ type: 'deferReply', payload: { flags: 64 } });
  expect(client.conversationHistory.has('dm-1')).toBe(true);

  release(new Error('previous reply failed'));
  await run;

  expect(client.conversationHistory.has('dm-1')).toBe(false);
  expect(client.conversationHistory.has('other')).toBe(true);
  expect(client.channelLastActivity.has('dm-1')).toBe(false);
  expect(client.channelCooldowns.has('dm-1')).toBe(false);
  expect(client.channelLocks.has('dm-1')).toBe(false);
  expect(calls[1].payload.content).toMatch(/cleared/);
});

test('should report when there is nothing to clear', async () => {
  const command = loadForgetCommand();
  const { interaction, calls } = createInteraction({});

  await command.execute(interaction);

  expect(calls[1].payload.content).toMatch(/no conversation history/);
});
