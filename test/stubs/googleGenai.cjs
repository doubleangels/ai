const defaultExports = {
  GoogleGenAI: class {
    constructor() {
      this.models = { generateContent: async () => ({ text: '' }) };
      this.caches = { create: async () => ({ name: 'cache' }) };
    }
  }
};

module.exports = global.__googleGenaiStub || defaultExports;
