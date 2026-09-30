import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server on :3000 with /api proxied to the FastAPI backend on :8000.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
