export default {
    testEnvironment: 'node',
    transform: {},
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    testMatch: ['**/*.test.js'],
    collectCoverageFrom: [
        'index.js',
        'src/**/*.js',
        '!**/node_modules/**',
        '!**/coverage/**'
    ]
};

