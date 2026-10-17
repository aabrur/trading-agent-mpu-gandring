import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = env.PORT || '8787';
  const webPort = Number(env.WEB_PORT || 5173);
  // The office proxies /api to the backend, so it must not be wider than the backend: this computer only by default,
  // always in LIVE. HOST=0.0.0.0 (PAPER/TESTNET) opens it to your network or tailnet.
  const live = String(env.TRADING_MODE ?? '').trim().toUpperCase() === 'LIVE';
  const webHost = live ? '127.0.0.1' : (env.HOST || '127.0.0.1').trim();
  return {
    root: 'web',
    plugins: [react()],
    // Only expose non-secret values to the browser. Keys never get a VITE_ prefix.
    envPrefix: 'PUBLIC_',
    server: {
      host: webHost,
      port: webPort,
      proxy: {
        '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
        '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true }
      }
    },
    build: { outDir: '../dist/web', emptyOutDir: true }
  };
});
