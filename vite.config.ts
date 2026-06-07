import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

const securityHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/ragCompressionDemo/' : '/',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'wasm-content-type',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
          if (req.url?.endsWith('.mjs'))  res.setHeader('Content-Type', 'application/javascript')
          for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v)
          next()
        })
      },
    },
  ],
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  worker: {
    format: 'es',
  },
  server:  { headers: securityHeaders },
  preview: { headers: securityHeaders },
})
