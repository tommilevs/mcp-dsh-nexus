import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/**/*.spec.ts', 'packages/**/*.spec.tsx'] } },
      { test: { name: 'e2e', include: ['packages/**/*.e2e.ts'] } },
    ],
  },
});
