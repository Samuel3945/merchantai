-- The WhatsApp agent no longer provisions its own POS device/caja
-- (see src/actions/whatsapp-channels.ts). Deactivate the phantom 'ai_agent'
-- pos_tokens that were auto-created per channel and surfaced as "cajas" in the
-- cash panel that never open a shift. The panel only lists active devices, so
-- deactivating hides them without touching any (nonexistent) cash history.
UPDATE "pos_tokens" SET "active" = false WHERE "device_name" = 'ai_agent' AND "active" = true;
