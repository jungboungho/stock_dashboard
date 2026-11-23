import { defineConfig } from 'vitest/config';

// 상대 경로로 빌드: GitHub Pages(/stock_dashboard/) 등 어떤 경로에서든 열림
export default defineConfig({
  base: './',
  test: { environment: 'node' },
});
