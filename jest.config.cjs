const base = {
  testEnvironment: 'node',
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  clearMocks: true,
  restoreMocks: true,
};
module.exports = {
  projects: [
    { ...base, displayName: 'unit', testMatch: ['<rootDir>/src/**/*.spec.ts'] },
    { ...base, displayName: 'integration', testMatch: ['<rootDir>/test/**/*.spec.ts'], testTimeout: 30000 },
  ],
};
