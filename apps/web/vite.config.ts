import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// NO `server.proxy`. It used to point `pnpm dev` at 127.0.0.1:7777, and since ADR-0007 moved
// factotum to 7877 that port belongs to something else on the owner's machine. The development
// loop is the `dev` daemon run from a worktree on 127.0.0.1:7778, with `vite build --watch`
// feeding its `dist/` — a loopback origin, so a secure context with a worker and notifications.
export default defineConfig({
  plugins: [preact()],
  // No modulepreload polyfill: there is one entry chunk and nothing to preload, and every browser
  // this serves (Chrome on Android and the Mac) has it natively. It was weight against criterion 30.
  build: { outDir: 'dist', emptyOutDir: true, modulePreload: { polyfill: false } },
})
