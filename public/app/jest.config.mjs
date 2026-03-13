// jest.config.mjs
export default {
  testEnvironment: 'node',
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: '.', outputName: 'junit.xml' }],
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['cobertura', 'lcov', 'text-summary'],
};
