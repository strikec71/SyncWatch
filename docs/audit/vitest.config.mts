import { defineConfig } from '../../extension/node_modules/vitest/dist/config.js';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, '../..'),
  resolve: { alias: { 'webextension-polyfill': resolve(import.meta.dirname, '../../extension/tests/stubs/webextension-polyfill.ts') } },
  test: { environment: 'node', include: ['docs/audit/regressions.test.ts'] },
});
