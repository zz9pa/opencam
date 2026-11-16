import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Two pages: the app and the help page (which renders docs/USER_GUIDE.md).
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        help: fileURLToPath(new URL('./help.html', import.meta.url)),
      },
    },
  },
});
