import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Limit concurrent Windows forks after observed native worker startup crashes.
    fileParallelism: process.platform === 'win32' ? false : true,
    maxWorkers: process.platform === 'win32' ? 2 : undefined,
    testTimeout: 20000,
    env: { TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEBATE_PACE_MS: '0', GROKBOT_WEBHOOK_URL: '', GROKBOT_WEBHOOK_KEY: '' }
  }
});
