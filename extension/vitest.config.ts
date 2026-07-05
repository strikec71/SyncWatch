import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Юнит-тесты чистой логики хаба + протокола. Модули хаба тянут webextension-polyfill,
// который в Node бросает исключение → алиасим его на безопасный стаб (tests/stubs).
export default defineConfig({
  resolve: {
    alias: {
      'webextension-polyfill': resolve(import.meta.dirname, 'tests/stubs/webextension-polyfill.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
