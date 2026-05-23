/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/jest.setup.cjs'],
  setupFilesAfterEnv: ['<rootDir>/test/jest.afterEnv.cjs'],
  moduleNameMapper: {
    '^dotenv$': '<rootDir>/test/stubs/dotenv.cjs',
    '^discord.js$': '<rootDir>/test/stubs/discord.cjs',
    '^pino$': '<rootDir>/test/stubs/pino.cjs',
    '^openai$': '<rootDir>/test/stubs/openai.cjs',
    '^@google/genai$': '<rootDir>/test/stubs/googleGenai.cjs',
    '^@anthropic-ai/sdk$': '<rootDir>/test/stubs/anthropic.cjs'
  },
  testMatch: ['<rootDir>/test/**/*.test.js'],
  maxWorkers: 1,
  coverageProvider: 'v8',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'index.js',
    'config.js',
    'deploy-commands.js',
    'instrument.js',
    'logger.js',
    'commands/**/*.js',
    'events/**/*.js',
    'utils/**/*.js'
  ],
  coveragePathIgnorePatterns: ['/node_modules/', '/test/'],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    }
  }
};
