import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  sourcemap: false,
  splitting: false,
  // The default template ships inside the bundle, so `show` works with nothing on disk.
  loader: { '.md': 'text' },
  banner: { js: '#!/usr/bin/env node' },
})
