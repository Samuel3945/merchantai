// The app_setting key that gates delivery photo evidence. Lives in a plain
// (non-'use server') module so both the server actions and the server component
// can share it — a 'use server' file may only export async functions, so this
// constant cannot live in actions.ts.
export const DELIVERY_REQUIRE_PHOTO_KEY = 'delivery_require_photo';
