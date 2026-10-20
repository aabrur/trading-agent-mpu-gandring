import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

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
    plugins: [react(), {
      name: 'office-runtime-assets',
      apply: 'build',
      closeBundle() {
        const output = path.resolve('dist/web');
        mkdirSync(output, { recursive: true });
        for (const file of ['favicon.webp', 'mpu-gandring-logo.webp']) {
          copyFileSync(path.resolve('web/public', file), path.join(output, file));
        }
        cpSync(path.resolve('web/public/office-assets'), path.join(output, 'office-assets'), { recursive: true });
      }
    }],
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
    build: {
      // The supplied authoring library stays local; ship only optimized room assets.
      copyPublicDir: false,
      outDir: '../dist/web',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (/[\\/]node_modules[\\/]lightweight-charts[\\/]/.test(id)) return 'charts';
              if (/[\\/]node_modules[\\/]react-dom[\\/]/.test(id)) return 'react-dom';
              if (/[\\/]node_modules[\\/](react|scheduler)[\\/]/.test(id)) return 'react';
            }
          }
        }
      }
    }
  };
});
