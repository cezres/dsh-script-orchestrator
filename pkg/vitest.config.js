import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['test/*.test.js'],
          exclude: ['test/client.test.js'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'client',
          include: ['test/client.test.js'],
          environment: 'jsdom',
        },
      },
    ],
  },
})
