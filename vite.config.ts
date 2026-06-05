import { defineConfig } from 'vitest/config';

// Tauri-friendly Vite config: fixed port (tauri.conf.json devUrl points here),
// keep the Rust compiler output readable.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'safari15', // macOS system WebView (WKWebView)
  },
  test: {
    environment: 'happy-dom', // localStorage, document, rAF for engine/music tests
  },
});
