import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  server: {
    port: 5174,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
