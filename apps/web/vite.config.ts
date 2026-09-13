import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: true },
  // Only used by `pnpm dev`; in production the kernel serves this from its own port.
  server: { proxy: { '/modules': 'http://127.0.0.1:7777', '/health': 'http://127.0.0.1:7777' } },
})
