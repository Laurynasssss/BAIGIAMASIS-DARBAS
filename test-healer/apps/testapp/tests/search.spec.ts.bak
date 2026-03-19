import { test, expect } from '@playwright/test';
import { captureFailure } from './hooks/failureCapture';

test.setTimeout(60000);

test.afterEach(async ({ page }, testInfo) => {
  await captureFailure(page, testInfo);
});

test.describe('Search and filters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app_for_testing.html');
  });

  test('search finds sci-fi movie via CSS selectors', async ({ page }) => {
    await page.fill('#search-card input[placeholder="Search movies"]', 'Matrix');
    await page.selectOption('#search-card select#search-filter', 'sci-fi');
    await page.click('#search-card button#search-btn');

    await expect(page.locator('#search-results li')).toContainText('Found: Matrix', { timeout: 15000 });
    await expect(page.locator('#search-meta')).toHaveText(/match\(es\)/);
  });

  test('filtering to mismatched genre shows empty state', async ({ page }) => {
    await page.fill('#search-card input[placeholder="Search movies"]', 'Matrix');
    await page.selectOption('#search-card select#search-filter', 'comedy');
    await page.click('#search-card button#search-btn');

    await expect(page.locator('#search-results li')).toHaveText('No results found', { timeout: 15000 });
    await expect(page.locator('#search-meta')).toHaveText('0 matches', { timeout: 15000 });
  });

  test('clearing search wipes results and meta', async ({ page }) => {
    await page.fill('#search-card input[placeholder="Search movies"]', 'Interstellar');
    await page.click('#search-card button#search-btn');
    await expect(page.locator('#search-results li')).toContainText('Interstellar', { timeout: 15000 });

    await page.click('#search-card button#clear-search');
    await expect(page.locator('#search-results li')).toHaveCount(0);
    await expect(page.locator('#search-meta')).toHaveText('', { timeout: 15000 });
  });
});
