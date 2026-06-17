// Single source of truth for the ORGANIZATION timezone.
//
// The business timezone is chosen ONCE when the business is created and is
// IMMUTABLE while it operates: every financial report buckets historical data
// by this zone (`AT TIME ZONE ...`), so changing it mid-life would retroactively
// rewrite the books. That is why there is deliberately no edit control in
// Ajustes — the choice belongs to onboarding / the /platform panel.
//
// The CODE is timezone-DYNAMIC, but the set of ALLOWED zones is intentionally
// Colombia-only for now. International rollout happens by phases from /platform,
// which widens SUPPORTED_TIMEZONES — no other code change is needed here.

export const ORG_TIMEZONE_SETTING_KEY = 'timezone';

export const DEFAULT_ORG_TIMEZONE = 'America/Bogota';

// IANA zones a business may currently operate in. A singleton today BY DESIGN.
export const SUPPORTED_TIMEZONES = [DEFAULT_ORG_TIMEZONE] as const;

export type SupportedTimezone = (typeof SUPPORTED_TIMEZONES)[number];

export function isSupportedTimezone(
  tz: string | null | undefined,
): tz is SupportedTimezone {
  return tz != null && (SUPPORTED_TIMEZONES as readonly string[]).includes(tz);
}

// Resolves a stored timezone to an effective IANA zone. Anything unset or not
// (yet) supported falls back to the default, so the system can never bucket on
// an unknown zone.
export function resolveOrgTimezone(stored: string | null | undefined): string {
  return isSupportedTimezone(stored) ? stored : DEFAULT_ORG_TIMEZONE;
}
