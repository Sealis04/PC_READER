CREATE TYPE "public"."component_category" AS ENUM('cpu', 'ram', 'storage', 'motherboard', 'gpu', 'nic', 'psu');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('in_use', 'spare', 'under_repair', 'for_disposal', 'disposed', 'lost');--> statement-breakpoint
CREATE TYPE "public"."os_type" AS ENUM('windows', 'macos');--> statement-breakpoint
CREATE TYPE "public"."scan_type" AS ENUM('scheduled', 'startup', 'on_demand', 'manual');--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"start_at" timestamp with time zone DEFAULT now() NOT NULL,
	"end_at" timestamp with time zone,
	"assigned_by" text NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"category" "component_category" NOT NULL,
	"match_key" text NOT NULL,
	"manufacturer" text,
	"model" text,
	"serial_number" text,
	"capacity_bytes" bigint,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inventory_number" text,
	"is_integrated" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "components_inventory_number_unique" UNIQUE("inventory_number")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_uuid" uuid NOT NULL,
	"inventory_number" text,
	"hostname" text NOT NULL,
	"os_type" "os_type" NOT NULL,
	"device_type" text,
	"manufacturer" text,
	"model" text,
	"serial_number" text,
	"status" "device_status" DEFAULT 'in_use' NOT NULL,
	"location" text,
	"last_seen_at" timestamp with time zone,
	"last_full_scan_at" timestamp with time zone,
	"token_hash" text,
	CONSTRAINT "devices_device_uuid_unique" UNIQUE("device_uuid"),
	CONSTRAINT "devices_inventory_number_unique" UNIQUE("inventory_number")
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"scan_uuid" uuid NOT NULL,
	"scan_type" "scan_type" NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	CONSTRAINT "scans_scan_uuid_unique" UNIQUE("scan_uuid")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"full_name" text NOT NULL,
	"employee_id" text NOT NULL,
	"email" text,
	"department" text NOT NULL,
	"position" text,
	"phone" text,
	"policy_acknowledged_at" timestamp with time zone,
	CONSTRAINT "users_employee_id_unique" UNIQUE("employee_id")
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignments_device_idx" ON "assignments" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_one_open_idx" ON "assignments" USING btree ("device_id") WHERE "assignments"."end_at" is null;--> statement-breakpoint
CREATE INDEX "components_device_idx" ON "components" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "components_active_match_idx" ON "components" USING btree ("device_id","match_key") WHERE "components"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_token_hash_idx" ON "devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "scans_device_collected_idx" ON "scans" USING btree ("device_id","collected_at");