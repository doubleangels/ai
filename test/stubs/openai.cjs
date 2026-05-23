const defaultExports = {
  OpenAI: class {
    constructor() {
      this.responses = { create: async () => ({ status: 'completed', output_text: '', id: 'r1', usage: {} }) };
    }
  }
};

module.exports = global.__openaiStub || defaultExports;
