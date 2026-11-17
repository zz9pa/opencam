import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Two pages: the app and the help page (which renders docs/USER_GUIDE.md).
export default defineConfig({
  // Relative paths, so the built site works from any address: GitHub Pages (/opencam/), a plain web server, or a copied folder.
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        help: fileURLToPath(new URL('./help.html', import.meta.url)),
      },
    },
  },
});
