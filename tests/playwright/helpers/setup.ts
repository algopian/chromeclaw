import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * Waits for the extension page to finish loading React.
 * Resolves once either the FirstRunSetup or Chat UI is visible.
 */
export const waitForAppReady = async (page: Page) => {
  // Wait for React to render one of the possible root states
  await expect(
    page
      .locator('[data-testid="setup-api-key"], textarea, [data-testid="user-menu-button"]')
      .first(),
  ).toBeVisible({ timeout: 15000 });
};

/**
 * If the FirstRunSetup is showing (no models configured),
 * completes it by entering a test API key so the Chat UI renders.
 */
export const bypassFirstRunSetup = async (page: Page) => {
  const setupVisible = await page
    .locator('[data-testid="setup-api-key"]')
    .isVisible()
    .catch(() => false);

  if (setupVisible) {
    // Step 1: Model setup
    await page.locator('[data-testid="setup-api-key"]').fill('sk-test-e2e-000000000000');
    await page.locator('[data-testid="setup-model-id"]').fill('test-model');
    await page.locator('[data-testid="setup-start-button"]').click();

    // Steps 2-5: Skip entire setup
    await page.locator('[data-testid="setup-skip-setup"]').click();

    // Wait for Chat UI to appear after setup completes
    await expect(page.locator('button[title="Toggle sidebar"], textarea').first()).toBeVisible({
      timeout: 10000,
    });
  }
};

/**
 * Navigates to the side panel, waits for load, and bypasses FirstRunSetup if needed.
 * Returns the page ready for Chat UI interactions.
 */
export const setupSidePanel = async (page: Page, extensionId: string) => {
  await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await bypassFirstRunSetup(page);
};

/**
 * Navigates to the full-page chat, waits for load, and bypasses FirstRunSetup if needed.
 */
export const setupFullPageChat = async (page: Page, extensionId: string) => {
  await page.goto(`chrome-extension://${extensionId}/full-page-chat/index.html`);
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await bypassFirstRunSetup(page);
};

/**
 * Navigate to Options > Channels tab and wait for Telegram Bot card.
 */
export const openChannelsTab = async (page: Page, extensionId: string) => {
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('h1')).toContainText('ChromeClaw Settings', { timeout: 10000 });
  await page.locator('nav button', { hasText: 'Channels' }).click();
  await expect(page.getByText('Telegram Bot', { exact: true })).toBeVisible({ timeout: 10000 });
};

/**
 * Mock Telegram Bot API responses at the network level for E2E tests.
 * Intercepts fetch calls to api.telegram.org from the service worker.
 */
export const mockTelegramApi = async (
  context: BrowserContext,
  overrides?: { valid?: boolean; username?: string },
) => {
  const { valid = true, username = 'test_e2e_bot' } = overrides ?? {};

  // Mock getMe (validate)
  await context.route('**/api.telegram.org/**/getMe', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        valid
          ? { ok: true, result: { id: 99999, is_bot: true, first_name: 'TestBot', username } }
          : { ok: false, description: 'Unauthorized' },
      ),
    }),
  );

  // Mock getUpdates (polling — return empty)
  await context.route('**/api.telegram.org/**/getUpdates**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, result: [] }),
    }),
  );

  // Mock setMyCommands (enable channel)
  await context.route('**/api.telegram.org/**/setMyCommands', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, result: true }),
    }),
  );
};
