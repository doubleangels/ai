const path = require('path');
const { reloadModule } = require('./testUtils.cjs');

const messageDeletePath = path.resolve(__dirname, '..', 'events', 'messageDelete.js');

test('should messageDelete removes matching assistant history on bot message delete', async () => {
  const handler = reloadModule(messageDeletePath);
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello there' }
  ];
  const client = {
    discordReady: true,
    user: { id: 'bot-123' },
    conversationHistory: new Map([['chan-1', history]])
  };

  await handler.execute({
    id: 'deleted-1',
    channelId: 'chan-1',
    content: 'hello there',
    author: { id: 'bot-123' },
    client
  });

  expect(history.length).toBe(2);
  expect(history[history.length - 1].role).toBe('user');
});

test('should messageDelete ignores non-bot and unrelated deletes', async () => {
  const handler = reloadModule(messageDeletePath);
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'stay' }
  ];
  const client = {
    discordReady: true,
    user: { id: 'bot-123' },
    conversationHistory: new Map([['chan-1', history]])
  };

  await handler.execute({
    id: 'deleted-2',
    channelId: 'chan-1',
    content: 'stay',
    author: { id: 'user-1' },
    client
  });
  await handler.execute({
    id: 'deleted-3',
    channelId: 'chan-1',
    content: 'different text',
    author: { id: 'bot-123' },
    client
  });

  expect(history.length).toBe(2);
});

test('should messageDelete no-ops when client is not ready or history is missing', async () => {
  const handler = reloadModule(messageDeletePath);
  const client = {
    discordReady: false,
    user: { id: 'bot-123' },
    conversationHistory: new Map()
  };

  await handler.execute({
    id: 'deleted-4',
    channelId: 'chan-1',
    content: 'hello',
    author: { id: 'bot-123' },
    client
  });

  expect(client.conversationHistory.size).toBe(0);
});

test('should messageDelete ignores deletes without channel history or assistant tail', async () => {
  const handler = reloadModule(messageDeletePath);
  const client = {
    discordReady: true,
    user: { id: 'bot-123' },
    conversationHistory: new Map([['chan-1', [{ role: 'system', content: 'sys' }]]])
  };

  await handler.execute({
    channelId: 'chan-1',
    content: '',
    author: { id: 'bot-123' },
    client
  });
  await handler.execute({
    channelId: 'missing',
    content: 'hello',
    author: { id: 'bot-123' },
    client
  });

  expect(client.conversationHistory.get('chan-1').length).toBe(1);
});

test('should messageDelete skips when last history entry is not assistant', async () => {
  const handler = reloadModule(messageDeletePath);
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'question' }
  ];
  const client = {
    discordReady: true,
    user: { id: 'bot-123' },
    conversationHistory: new Map([['chan-1', history]])
  };

  await handler.execute({
    channelId: 'chan-1',
    content: 'question',
    author: { id: 'bot-123' },
    client
  });

  expect(history.length).toBe(2);
});

test('should messageDelete skips deletes with empty author id', async () => {
  const handler = reloadModule(messageDeletePath);
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'hello' }
  ];
  const client = {
    discordReady: true,
    user: { id: 'bot-123' },
    conversationHistory: new Map([['chan-1', history]])
  };

  await handler.execute({
    channelId: 'chan-1',
    content: 'hello',
    author: { id: '' },
    client
  });

  expect(history.length).toBe(2);
});

test('should messageDelete skips deletes with missing author id', async () => {
  const handler = reloadModule(messageDeletePath);
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'hello' }
  ];
  const client = {
    discordReady: true,
    user: { id: 'bot-123' },
    conversationHistory: new Map([['chan-1', history]])
  };

  await handler.execute({
    channelId: 'chan-1',
    content: 'hello',
    author: undefined,
    client
  });

  expect(history.length).toBe(2);
});

test('should messageDelete skips when stored assistant content is empty', async () => {
  const handler = reloadModule(messageDeletePath);
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] }
  ];
  const client = {
    discordReady: true,
    user: { id: 'bot-123' },
    conversationHistory: new Map([['chan-1', history]])
  };

  await handler.execute({
    channelId: 'chan-1',
    content: 'deleted text',
    author: { id: 'bot-123' },
    client
  });

  expect(history.length).toBe(2);
});

test('should messageDelete skips when deleted message content is null', async () => {
  const handler = reloadModule(messageDeletePath);
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'hello' }
  ];
  const client = {
    discordReady: true,
    user: { id: 'bot-123' },
    conversationHistory: new Map([['chan-1', history]])
  };

  await handler.execute({
    channelId: 'chan-1',
    content: null,
    author: { id: 'bot-123' },
    client
  });

  expect(history.length).toBe(2);
});

test('should messageDelete skips when deleted content is blank', async () => {
  const handler = reloadModule(messageDeletePath);
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'hello' }
  ];
  const client = {
    discordReady: true,
    user: { id: 'bot-123' },
    conversationHistory: new Map([['chan-1', history]])
  };

  await handler.execute({
    channelId: 'chan-1',
    content: '   ',
    author: { id: 'bot-123' },
    client
  });

  expect(history.length).toBe(2);
});
