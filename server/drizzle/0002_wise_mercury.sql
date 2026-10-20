CREATE TYPE "public"."device_history_field" AS ENUM('inventory_number', 'location');--> statement-breakpoint
CREATE TABLE "device_field_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"field" "device_history_field" NOT NULL,
	"old_value" text,
	"new_value" text,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "inventory_counters" (
	"year" integer PRIMARY KEY NOT NULL,
	"last_value" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"old_status" "device_status" NOT NULL,
	"new_status" "device_status" NOT NULL,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT "devices_inventory_number_unique";--> statement-breakpoint
ALTER TABLE "device_field_history" ADD CONSTRAINT "device_field_history_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_field_history_device_idx" ON "device_field_history" USING btree ("device_id","changed_at");--> statement-breakpoint
CREATE INDEX "status_history_device_idx" ON "status_history" USING btree ("device_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_inventory_number_lower_idx" ON "devices" USING btree (lower("inventory_number"));--> statement-breakpoint
CREATE INDEX "devices_status_idx" ON "devices" USING btree ("status");