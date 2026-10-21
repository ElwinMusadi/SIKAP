import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@shared': path.resolve(import.meta.dirname, './shared'),
    },
  },
  server: {
    // `npm run dev` alone serves the SPA only; API requests are proxied to
    // `wrangler pages dev` (npm run dev:api) when it runs on 8788.
    proxy: {
      '/api': 'http://127.0.0.1:8788',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: {
      output: {
        // Stable, cacheable vendor chunks shared by all routes.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/ },
            { name: 'query', test: /node_modules[\\/]@tanstack[\\/](query-core|react-query)[\\/]/ },
            // Data tables only (admin lists, log): kept out of the chunk every page (and the login) preloads.
            { name: 'tanstack-table', test:/node_modules[\\/]@tanstack[\\/](table-core|react-table|store|react-store)[\\/]/ },
            { name: 'radix', test: /node_modules[\\/](radix-ui|@radix-ui)[\\/]/ },
            { name: 'forms', test: /node_modules[\\/](zod|react-hook-form|@hookform)[\\/]/ },
          ],
        },
      },
    },
  },
});
