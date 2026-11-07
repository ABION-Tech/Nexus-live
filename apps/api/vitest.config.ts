import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // buildServer() reads NODE_ENV to decide whether to call app.listen()
    // (server.ts, bottom) — vitest sets this to 'test' by default, which
    // is exactly the guard that already existed for this purpose.
  },
});
