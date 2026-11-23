import { defineConfig } from 'vitest/config';

// Claude 아티팩트로 게시: 어떤 경로에서든 열리도록 상대 경로로 빌드
export default defineConfig({
  base: './',
  test: { environment: 'node' },
});
