import { expect, test } from '@playwright/test';

test.describe('I18n', () => {
  test.describe('Locale routing', () => {
    // next-intl negotiates the unprefixed route from the Accept-Language header.
    // Playwright defaults to en-US, so we pin the browser to Spanish to make the
    // default (unprefixed) route deterministic. English always resolves under
    // its explicit `/en` prefix regardless of the browser language.
    test.use({ locale: 'es-CO' });

    test('serves Spanish at the root and English under /en', async ({ page }) => {
      await page.goto('/');

      await expect(page.locator('html')).toHaveAttribute('lang', 'es');

      await page.goto('/en');

      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    });
  });
});
