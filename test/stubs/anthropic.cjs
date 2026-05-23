module.exports = global.__anthropicStub || class FakeAnthropic {
  constructor() {
    this.messages = { create: async () => ({ content: [{ type: 'text', text: '' }] }) };
  }
};
