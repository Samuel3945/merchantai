/**
 * Phone normalization for matching a WhatsApp `remoteJid` against a stored
 * business phone. The two sides never share a format:
 *
 *   remoteJid:      "573001234567@s.whatsapp.net"
 *   business_phone: "+57 300 123 4567" | "3001234567" | "300-123-4567" | ...
 *
 * Reducing both to their last 10 digits (the Colombian mobile subscriber number,
 * without the country code) makes the comparison format-agnostic: country
 * prefix, spaces, dashes and the `@s.whatsapp.net` suffix all fall away.
 */
export function phoneDigits(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.slice(-10);
}
