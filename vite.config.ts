import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * 前端构建配置。
 * Worker 代码不经过 Vite 打包（由 wrangler 自己 esbuild），
 * 但单元测试会在 Node 里直接跑 Worker 的纯逻辑模块。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
