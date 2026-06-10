import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // `vite build --mode single` produces a self-contained dist/index.html
    // (all JS/CSS inlined) that runs from a file:// double-click — no npm needed.
    ...(mode === 'single' ? [viteSingleFile()] : []),
  ],
}))
