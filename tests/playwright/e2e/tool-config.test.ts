import { test } from '../fixtures/extension';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Navigate to options and wait for the page to be ready. */
const openOptions = async (page: Page, extensionId: string) => {
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('h1')).toContainText('ChromeClaw Settings', { timeout: 10000 });
};

/** Click a tab in the options page nav. */
const clickTab = async (page: Page, tabName: string) => {
  await page.locator('nav button', { hasText: tabName }).click();
};

test.describe('Tool Config @phase-10', () => {
  test('browser tool checkbox is visible in Tool tab', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await clickTab(page, 'Tool');

    await expect(page.locator('#tool-browser')).toBeVisible();

    await page.close();
  });

  test('web_fetch tool checkbox is visible in Tool tab', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await clickTab(page, 'Tool');

    await expect(page.locator('#tool-webfetch')).toBeVisible();

    await page.close();
  });

  test('tool toggle persists across page reload', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await clickTab(page, 'Tool');

    const browserCheckbox = page.locator('#tool-browser');

    // Ensure it starts checked
    if (!(await browserCheckbox.isChecked())) {
      await browserCheckbox.check();
      await page.waitForTimeout(500); // Wait for auto-save
    }

    // Toggle off
    await browserCheckbox.uncheck();
    await page.waitForTimeout(500); // Wait for auto-save

    // Reload and verify still off
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('h1')).toContainText('ChromeClaw Settings', { timeout: 10000 });
    await clickTab(page, 'Tool');
    await expect(browserCheckbox).not.toBeChecked();

    // Toggle back on
    await browserCheckbox.check();
    await page.waitForTimeout(500); // Wait for auto-save

    // Reload and verify still on
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('h1')).toContainText('ChromeClaw Settings', { timeout: 10000 });
    await clickTab(page, 'Tool');
    await expect(browserCheckbox).toBeChecked();

    await page.close();
  });
});
