import { expect, test } from '@playwright/test';

test.describe('I18n', () => {
  test.describe('Locale routing', () => {
    // The app supports Spanish (default) and English. With `localePrefix:
    // 'as-needed'`, the default locale has no prefix and English lives under
    // `/en`. We assert the `<html lang>` the layout sets, so the test does not
    // depend on translated marketing copy.
    test('should serve Spanish by default and English under /en', async ({ page }) => {
      await page.goto('/');

      await expect(page.locator('html')).toHaveAttribute('lang', 'es');

      await page.goto('/en');

      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    });
  });
});
