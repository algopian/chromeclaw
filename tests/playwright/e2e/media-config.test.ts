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

test.describe('Media Configuration @phase-9', () => {
  test('Media Configuration card is visible on Tool tab', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    await clickTab(page, 'Tool');

    // Media Configuration card should be visible
    await expect(page.locator('text=Media Configuration')).toBeVisible({ timeout: 10000 });

    // Audio Transcription section heading
    await expect(page.locator('h3', { hasText: 'Audio Transcription' })).toBeVisible();

    await page.close();
  });

  test('Engine selector shows default Whisper (Local) value', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    await clickTab(page, 'Tool');

    // Wait for Media Configuration to load
    await expect(page.locator('text=Media Configuration')).toBeVisible({ timeout: 10000 });

    // Engine selector should show "Whisper (Local)" by default
    const engineTrigger = page.locator('#stt-engine');
    await expect(engineTrigger).toBeVisible();
    await expect(engineTrigger).toContainText('Whisper (Local)');

    await page.close();
  });

  test('Local model fields visible by default (transformers engine)', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    await clickTab(page, 'Tool');
    await expect(page.locator('text=Media Configuration')).toBeVisible({ timeout: 10000 });

    // Local model fields should be visible with default transformers engine
    await expect(page.locator('#stt-local-model')).toBeVisible();
    await expect(page.locator('#stt-download-model')).toBeVisible();

    // OpenAI fields should NOT be visible
    await expect(page.locator('#stt-api-key')).not.toBeVisible();
    await expect(page.locator('#stt-model')).not.toBeVisible();
    await expect(page.locator('#stt-base-url')).not.toBeVisible();

    await page.close();
  });

  test('OpenAI fields visible when engine switched to openai', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    await clickTab(page, 'Tool');
    await expect(page.locator('text=Media Configuration')).toBeVisible({ timeout: 10000 });

    // Switch to OpenAI
    await page.locator('#stt-engine').click();
    await page.locator('[role="option"]', { hasText: 'OpenAI' }).click();

    // OpenAI fields should be visible
    await expect(page.locator('#stt-api-key')).toBeVisible();
    await expect(page.locator('#stt-model')).toBeVisible();
    await expect(page.locator('#stt-base-url')).toBeVisible();

    // Local model fields should NOT be visible
    await expect(page.locator('#stt-local-model')).not.toBeVisible();

    await page.close();
  });

  test('OpenAI fields reappear when engine changed to openai', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    await clickTab(page, 'Tool');
    await expect(page.locator('text=Media Configuration')).toBeVisible({ timeout: 10000 });

    // Switch to OpenAI
    await page.locator('#stt-engine').click();
    await page.locator('[role="option"]', { hasText: 'OpenAI' }).click();
    await expect(page.locator('#stt-api-key')).toBeVisible();

    // Switch back to Local
    await page.locator('#stt-engine').click();
    await page.locator('[role="option"]', { hasText: 'Whisper (Local)' }).click();
    await expect(page.locator('#stt-api-key')).not.toBeVisible();

    // Switch to OpenAI again
    await page.locator('#stt-engine').click();
    await page.locator('[role="option"]', { hasText: 'OpenAI' }).click();
    await expect(page.locator('#stt-api-key')).toBeVisible();
    await expect(page.locator('#stt-model')).toBeVisible();
    await expect(page.locator('#stt-base-url')).toBeVisible();

    await page.close();
  });

  test('Language field is always visible', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    await clickTab(page, 'Tool');
    await expect(page.locator('text=Media Configuration')).toBeVisible({ timeout: 10000 });

    // Language field visible with default transformers engine
    await expect(page.locator('#stt-language')).toBeVisible();

    // Switch to OpenAI — language should still be visible
    await page.locator('#stt-engine').click();
    await page.locator('[role="option"]', { hasText: 'OpenAI' }).click();
    await expect(page.locator('#stt-language')).toBeVisible();

    await page.close();
  });

  test('Engine description updates when engine changes', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    await clickTab(page, 'Tool');
    await expect(page.locator('text=Media Configuration')).toBeVisible({ timeout: 10000 });

    // Default transformers engine description
    await expect(page.locator('text=Runs a transformer model locally via ONNX')).toBeVisible();

    // Switch to OpenAI
    await page.locator('#stt-engine').click();
    await page.locator('[role="option"]', { hasText: 'OpenAI' }).click();
    await expect(page.locator("text=Uses OpenAI's Whisper API")).toBeVisible();

    await page.close();
  });

  test('API key and model fields accept input', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    await clickTab(page, 'Tool');
    await expect(page.locator('text=Media Configuration')).toBeVisible({ timeout: 10000 });

    // Switch to OpenAI to see API key fields
    await page.locator('#stt-engine').click();
    await page.locator('[role="option"]', { hasText: 'OpenAI' }).click();

    // Fill in API key
    await page.locator('#stt-api-key').fill('sk-test-key-123');
    await expect(page.locator('#stt-api-key')).toHaveValue('sk-test-key-123');

    // Fill in model
    await page.locator('#stt-model').clear();
    await page.locator('#stt-model').fill('whisper-large-v3');
    await expect(page.locator('#stt-model')).toHaveValue('whisper-large-v3');

    // Fill in language
    await page.locator('#stt-language').clear();
    await page.locator('#stt-language').fill('ja');
    await expect(page.locator('#stt-language')).toHaveValue('ja');

    await page.close();
  });

  test('Media Configuration card not visible on other tabs', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    // General tab (default) — should NOT show Media Configuration
    await expect(page.locator('text=Media Configuration')).not.toBeVisible();

    // Model tab
    await clickTab(page, 'Model');
    await expect(page.locator('text=Media Configuration')).not.toBeVisible();

    // Skills tab
    await clickTab(page, 'Skills');
    await expect(page.locator('text=Media Configuration')).not.toBeVisible();

    await page.close();
  });

  test('Model selector visible when engine is transformers', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    await clickTab(page, 'Tool');
    await expect(page.locator('text=Media Configuration')).toBeVisible({ timeout: 10000 });

    // Default is transformers — model selector and download button should be visible
    await expect(page.locator('#stt-local-model')).toBeVisible();
    await expect(page.locator('#stt-download-model')).toBeVisible();

    await page.close();
  });

  test('Model selector hidden when engine is openai', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    await clickTab(page, 'Tool');
    await expect(page.locator('text=Media Configuration')).toBeVisible({ timeout: 10000 });

    // Switch to OpenAI
    await page.locator('#stt-engine').click();
    await page.locator('[role="option"]', { hasText: 'OpenAI' }).click();

    // Model selector should NOT be visible
    await expect(page.locator('#stt-local-model')).not.toBeVisible();
    await expect(page.locator('#stt-download-model')).not.toBeVisible();

    await page.close();
  });
});
