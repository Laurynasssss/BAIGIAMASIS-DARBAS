import path from 'path';
import { defineConfig } from '@playwright/test';

const projectRoot = path.resolve(__dirname, '..', '..'); // .../test-healer
const artifactsDir = path.join(projectRoot, 'artifacts', 'test-results');

export default defineConfig({
  testDir: './tests',
  outputDir: artifactsDir,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});