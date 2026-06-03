/**
 * Failure codes for plan-limit-reached ActionResults. Single source of truth so
 * the server (which returns the code) and the client (which matches it to render
 * the upgrade CTA) can't drift apart silently. A "use server" module can import
 * these, but cannot re-export non-async members — so the codes live here.
 */
export const POS_DEVICES_LIMIT_REACHED = 'pos_devices_limit_reached';
export const CASHIERS_LIMIT_REACHED = 'cashiers_limit_reached';
