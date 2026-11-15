import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // 5180 and API 4100, so this can run next to Memoir (5173 / 4000)
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    // The API answers under /api. Going through this proxy keeps the app and the API on one origin,
    // so the httpOnly session cookie just works. xfwd passes the real client IP on for rate limiting.
    proxy: {
      '/api': { target: 'http://127.0.0.1:4100', xfwd: true },
    },
  },
})
