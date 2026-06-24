-- Treasury account name uniqueness is now scoped to ACTIVE accounts only.
-- A deleted (active=false) account previously kept its name reserved, so an
-- owner who deleted e.g. "Bancolombia" and later wanted it back was blocked
-- (had to pick a different name). Making the unique index PARTIAL frees a
-- deleted account's name for reuse, while still preventing two LIVE accounts
-- from sharing a name within the same org.
DROP INDEX IF EXISTS "treasury_accounts_org_name_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_accounts_org_name_unique" ON "treasury_accounts" ("organization_id","name") WHERE "active" = true;
