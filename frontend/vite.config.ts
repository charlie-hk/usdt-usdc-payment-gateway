import { defineConfig } from 'vite';

// Relative base so the build works from any path (GitHub Pages project sites, IPFS, a plain file server).
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
