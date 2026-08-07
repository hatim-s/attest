import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const config = defineConfig({
  build: {
    cssCodeSplit: false,
    target: 'es2022',
  },
  plugins: [react(), tailwindcss(), viteSingleFile()],
});

export { config as default };
