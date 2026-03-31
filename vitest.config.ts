import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/dashboard/**', 'src/hook/**'],
    },
  },
});
