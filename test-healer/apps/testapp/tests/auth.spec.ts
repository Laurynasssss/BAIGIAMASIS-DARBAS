import { test, expect } from '@playwright/test';
import { captureFailure } from './hooks/failureCapture';

test.setTimeout(60000);

test.afterEach(async ({ page }, testInfo) => {
	await captureFailure(page, testInfo);
});

test.describe('Auth flows', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/app_for_testing.html');
	});

	test('successful login updates status pill', async ({ page }) => {
		await page.fill('#login-card input[type="email"]', 'test@test.com');
		await page.fill('#login-card input[type="password"]', '1234');
		await page.click('#login-card button.login-btn');

		await expect(page.locator('#login-message')).toHaveText('Login successful', { timeout: 15000 });
		await expect(page.locator('#login-status-pill')).toHaveText(/Signed in|Remembered/, { timeout: 15000 });
	});

	test('failed login shows error and does not change pill', async ({ page }) => {
		await page.fill('#login-card input[type="email"]', 'wrong@test.com');
		await page.fill('#login-card input[type="password"]', 'bad');
		await page.click('#login-card button.login-btn');

		await expect(page.locator('#login-message')).toHaveText('Invalid credentials', { timeout: 15000 });
		await expect(page.locator('#login-status-pill')).toHaveText('Guest', { timeout: 15000 });
	});

	test('remember me alters status', async ({ page }) => {
		await page.fill('#login-card input[type="email"]', 'test@test.com');
		await page.fill('#login-card input[type="password"]', '1234');
		await page.check('#login-card input[type="checkbox"]#remember-me');
		await page.click('#login-card button.login-btn');

		await expect(page.locator('#login-message')).toHaveText('Login successful', { timeout: 15000 });
		await expect(page.locator('#login-status-pill')).toHaveText('Remembered', { timeout: 15000 });
	});
});
