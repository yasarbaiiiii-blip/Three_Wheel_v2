import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'expo-file-system/legacy': path.resolve(__dirname, 'src/test/mocks/expo-file-system.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.mts'],
    globals: true,
    environment: 'node',
  },
});
