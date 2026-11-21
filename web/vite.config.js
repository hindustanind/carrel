import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = p => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: r('.'),
  publicDir: r('./public'),
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: false }, '/s/': { target: 'http://localhost:5173', rewrite: () => '/app.html' } } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: { input: { index: r('./index.html'), app: r('./app.html'), admin: r('./admin.html') } },
  },
});
