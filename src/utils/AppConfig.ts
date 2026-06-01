import type { LocalizationResource } from '@clerk/shared/types';
import type { LocalePrefixMode } from 'next-intl/routing';
import type { AppLocale } from '@/types/I18n';
import { enUS, esES, frFR } from '@clerk/localizations';

/** Locale prefix strategy for next-intl routing. */
const localePrefix: LocalePrefixMode = 'as-needed';
const locales = [
  {
    id: 'es',
    name: 'Español',
  },
  {
    id: 'en',
    name: 'English',
  },
  {
    id: 'fr',
    name: 'Français',
  },
] satisfies AppLocale[];

/** Centralized application configuration */
export const AppConfig = {
  name: 'MyMerchantAI',
  i18n: {
    locales,
    defaultLocale: 'es',
    localePrefix,
  },
  email: {
    support: 'soporte@mymerchantai.com',
  },
} as const;

const supportedLocales: Record<string, LocalizationResource> = {
  es: esES,
  en: enUS,
  fr: frFR,
};

export const ClerkLocalizations = {
  defaultLocale: esES,
  supportedLocales,
};

export const AllLocales = AppConfig.i18n.locales.map(locale => locale.id);
