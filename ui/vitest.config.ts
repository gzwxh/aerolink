import path from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
    css: true,
    clearMocks: true,
    restoreMocks: true,
    // 每个 jsdom fork 约占 120~400MB，本机内存有限（曾因并发 fork 打爆内存触发 OOM 假死）
    maxWorkers: 4,
  },
})
