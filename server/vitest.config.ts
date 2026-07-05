import { defineConfig } from 'vitest/config';

// Чистая логика комнаты (roomLogic) не зависит от Workers runtime — гоняем в Node.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
