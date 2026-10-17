import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = env.PORT || '8787';
  const webPort = Number(env.WEB_PORT || 5173);
  return {
    root: 'web',
    plugins: [react()],
    // Only expose non-secret values to the browser. Keys never get a VITE_ prefix.
    envPrefix: 'PUBLIC_',
    server: {
      host: '0.0.0.0',
      port: webPort,
      proxy: {
        '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
        '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true }
      }
    },
    build: { outDir: '../dist/web', emptyOutDir: true }
  };
});
