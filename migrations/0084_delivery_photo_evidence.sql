-- Delivery photo evidence: a nullable delivery_photo_url column on
-- delivery_orders holds the courier-captured hand-off photo, uploaded via
-- POST /api/upload/delivery-photo and stored under
-- deliveries/<orgId>/<deliveryOrderId>/. Nullable on purpose — enforcement of
-- the org's `delivery_require_photo` app_setting happens server-side in
-- transitionDelivery, not via a NOT NULL constraint (which would break every
-- historical row and every org that leaves the setting off).
ALTER TABLE "delivery_orders" ADD COLUMN "delivery_photo_url" text;
