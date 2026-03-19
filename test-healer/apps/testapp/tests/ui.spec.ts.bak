import { test, expect } from '@playwright/test';
import { captureFailure } from './hooks/failureCapture';

test.setTimeout(60000);

test.afterEach(async ({ page }, testInfo) => {
  await captureFailure(page, testInfo);
});

test.describe('UI interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app_for_testing.html');
  });

  test('modal opens and closes', async ({ page }) => {
    await page.click('header .inline-actions button#open-modal');
    await expect(page.locator('#info-modal')).toBeVisible();
    await expect(page.locator('#info-modal .modal-content li')).toHaveCount(3);

    await page.click('#info-modal button#close-modal');
    await expect(page.locator('#info-modal')).toBeHidden();
  });

  test('tabs switch panels via class selectors', async ({ page }) => {
    await page.click('#tabs-card .tabs button[data-tab="activity"]');
    await expect(page.locator('#tab-activity')).toHaveClass(/active/);
    await expect(page.locator('#tab-overview')).not.toHaveClass(/active/);

    await page.click('#tabs-card .tabs button[data-tab="settings"]');
    await expect(page.locator('#tab-settings')).toHaveClass(/active/);
    await expect(page.locator('#tab-activity')).not.toHaveClass(/active/);
  });

  test('accordion toggles panels', async ({ page }) => {
    await page.click('#faq-card .accordion button[data-panel="faq-b"]');
    await expect(page.locator('#faq-b')).toBeVisible();

    await page.click('#faq-card .accordion button[data-panel="faq-c"]');
    await expect(page.locator('#faq-c')).toBeVisible();
    await expect(page.locator('#faq-b')).toBeHidden();
  });

  test('todo list add and complete', async ({ page }) => {
    const todoInput = '#todo-cards .inline-actions input#todo-input';
    const addBtn = '#todo-cards button#add-todo';

    await page.fill(todoInput, 'Write selectors with classes');
    await page.click(addBtn);

    const todos = page.locator('#todo-cards .todo-item');
    await expect(todos).toHaveCount(3);

    const lastTodoCheckbox = todos.nth(2).locator('input[type="checkbox"]');
    await lastTodoCheckbox.check();
    await expect(todos.nth(2)).toHaveClass(/done/);
  });

  test('library table filters by genre and rating', async ({ page }) => {
    await page.selectOption('#data-card select#genre-filter', 'sci-fi');
    await page.selectOption('#data-card select#rating-filter', '4.5');

    const rows = page.locator('#data-card table#library-table tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Matrix', { timeout: 15000 });
    await expect(rows.nth(1)).toContainText('Back to the Future', { timeout: 15000 });
  });

  test('theme toggle sets dark mode attribute', async ({ page }) => {
    await page.click('header button#theme-toggle');
    await expect(page.locator('body[data-theme="dark"]')).toBeVisible();
  });
});
