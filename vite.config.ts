import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/ragCompressionDemo/' : '/',
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  worker: {
    format: 'es',
  },
  // COOP/COEP headers are injected by coi-serviceworker.js (same as advancedRag)
  // so CDN requests (pdf.js, model weights) are not blocked
})
