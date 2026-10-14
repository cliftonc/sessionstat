import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  // Same as tsup: `import tpl from './default.md'` yields the file's text.
  plugins: [
    {
      name: 'md-as-text',
      transform(code, id) {
        if (id.endsWith('.md')) return { code: `export default ${JSON.stringify(code)}`, map: null }
        return null
      },
    },
  ],
})
