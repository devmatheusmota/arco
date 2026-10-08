import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1422,
    strictPort: true,
    // Não vigie o backend Rust: o watcher do vite tenta observar
    // src-tauri/target/**/*.dll enquanto o linker ainda está escrevendo o
    // arquivo e estoura EBUSY, derrubando o dev server a cada rebuild do Rust.
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
        passes: 2,
      },
      mangle: {
        toplevel: true,
      },
      format: {
        comments: false,
      },
    },
    rollupOptions: {
      output: {
        // A function, not the object form: the object form pulls every
        // dependency of a listed package into its chunk, so a small module the
        // startup code shared with Mermaid or react-markdown (the JSX runtime
        // among them) made the page preload both libraries on every launch.
        // Mermaid and Cytoscape are left out on purpose: they are only reached
        // through lazy imports, and Rollup splits them, and Mermaid's diagram
        // parsers, into chunks that load when a diagram needs them.
        manualChunks(id) {
          // Every lazy import goes through this helper. Left to Rollup, it was
          // captured by a chunk of a lazy library, and the startup code had to
          // load that library to reach it.
          if (id.includes('vite/preload-helper')) return 'react'
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/]@xterm[\\/]/.test(id)) return 'xterm'
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
          if (/[\\/]node_modules[\\/](react-markdown|remark-gfm)[\\/]/.test(id)) return 'markdown'
          return undefined
        },
      },
    },
  },
})
