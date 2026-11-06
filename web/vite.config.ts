import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let controllers = ['main']

export default defineConfig({
  plugins: [
    {
      name: 'console-controller-manifest',
      configResolved(config) {
        controllers =
          config.env.VITE_CODEX_CONTROLLER === 'true'
            ? ['main', 'codex']
            : ['main']
      },
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'controllers.json',
          source: JSON.stringify({ controllers }),
        })
      },
    },
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target:
          process.env.VM2API_API_PROXY ||
          process.env.KIN_API_PROXY ||
          'http://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
