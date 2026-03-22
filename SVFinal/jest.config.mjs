/**
 * jest.config.mjs
 */
export default {
  testEnvironment:    'node',
  transform:          {},           // ESM — no transform needed with Node 18+
  extensionsToTreatAsEsm: ['.js'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: [
    '**/tests/**/*.test.js',
  ],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/wasm/**',
  ],
  coverageThreshold: {
    global: {
      branches:   60,
      functions:  70,
      lines:      70,
      statements: 70,
    }
  }
};
