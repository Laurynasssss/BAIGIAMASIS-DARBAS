import { Page, TestInfo } from '@playwright/test';
import path from 'path';
import fs from 'fs';

export async function captureFailure(page: Page | undefined, testInfo: TestInfo) {
  if (testInfo.status === testInfo.expectedStatus) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const testName = testInfo.title.replace(/\s+/g, '_');

  const projectRoot = path.resolve(__dirname, '..', '..', '..', '..'); // .../test-healer
  const failureDir = path.resolve(projectRoot, 'artifacts', 'failures', `${testName}_${timestamp}`);

  fs.mkdirSync(failureDir, { recursive: true });

  fs.writeFileSync(
    path.join(failureDir, 'error.json'),
    JSON.stringify(
      {
        title: testInfo.title,
        file: testInfo.file,
        error: testInfo.error?.message,
        stack: testInfo.error?.stack,
        retry: testInfo.retry,
      },
      null,
      2,
    ),
  );

  if (page) {
    const dom = await page.content();
    fs.writeFileSync(path.join(failureDir, 'dom.html'), dom);

    await page.screenshot({
      path: path.join(failureDir, 'screenshot.png'),
      fullPage: true,
    });
  }

  const testSource = fs.readFileSync(testInfo.file, 'utf-8');
  fs.writeFileSync(path.join(failureDir, 'test-source.js'), testSource);

  console.log(`❌ Failure captured: ${failureDir}`);
}