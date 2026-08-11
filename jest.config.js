module.exports = {
  // Default to jsdom for unit tests
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'Extension/**/*.js',
    '!Extension/popup.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  verbose: true,

  // Use Node environment for integration tests (they make real HTTP calls)
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'jsdom',
      setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
      testMatch: ['**/tests/*.test.js'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['**/tests/integration/**/*.test.js'],
      // No setup file for integration tests - they use real APIs
    },
    {
      // Real end-to-end round-trips (Voyager + Affinity). Node env for global
      // fetch/Buffer; creds come from Keychain and the suite skips without them.
      displayName: 'e2e',
      testEnvironment: 'node',
      testMatch: ['**/tests/e2e/**/*.test.js'],
    }
  ]
};
