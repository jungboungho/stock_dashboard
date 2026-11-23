import { defineConfig } from 'vitest/config';

// GitHub Pages 는 https://<user>.github.io/stock_dashboard/ 아래에서 서비스되므로 base 경로가 필요
export default defineConfig({
  base: '/stock_dashboard/',
  test: { environment: 'node' },
});
