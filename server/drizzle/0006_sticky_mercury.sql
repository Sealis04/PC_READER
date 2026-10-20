CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"agency_name" text DEFAULT 'PC_READER' NOT NULL,
	"inventory_prefix" text DEFAULT 'INV' NOT NULL,
	"logo" "bytea",
	"logo_content_type" text,
	"logo_updated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- Upgrade rule (appended to the generated DDL): servers that already issued IA-YYYY-NNNNN numbers keep
-- that format; new servers start with the neutral default INV.
INSERT INTO "app_settings" ("id", "inventory_prefix")
VALUES (1, CASE WHEN EXISTS (SELECT 1 FROM "devices" WHERE "inventory_number" ~* '^IA-[0-9]{4}-[0-9]{5}$') OR EXISTS (SELECT 1 FROM "inventory_counters") THEN 'IA' ELSE 'INV' END)
ON CONFLICT ("id") DO NOTHING;
