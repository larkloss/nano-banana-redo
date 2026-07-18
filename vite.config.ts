import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// `vite build --mode single` / `--mode single-edit` each produce one
// self-contained HTML (all JS/CSS inlined) that runs from a file://
// double-click — no npm needed. vite-plugin-singlefile can't handle
// multiple entries, so single-file artifacts are built one at a time.
export default defineConfig(({ mode }) => {
  const singleEntry =
    mode === 'single'
      ? 'index.html'
      : mode === 'single-edit'
        ? 'edit.html'
        : mode === 'single-video'
          ? 'video.html'
          : null
  const input: Record<string, string> = singleEntry
    ? { app: singleEntry }
    : { main: 'index.html', edit: 'edit.html', video: 'video.html' }
  return {
    plugins: [react(), tailwindcss(), ...(singleEntry ? [viteSingleFile()] : [])],
    build: {
      rollupOptions: { input },
    },
  }
})
