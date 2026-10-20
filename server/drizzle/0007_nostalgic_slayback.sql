CREATE TYPE "public"."custom_field_type" AS ENUM('text', 'date', 'secret');--> statement-breakpoint
CREATE TYPE "public"."secret_action" AS ENUM('reveal', 'set', 'clear');--> statement-breakpoint
ALTER TYPE "public"."device_history_field" ADD VALUE 'custom_field';--> statement-breakpoint
ALTER TYPE "public"."unlock_method" ADD VALUE 'reveal_secret';--> statement-breakpoint
ALTER TYPE "public"."unlock_method" ADD VALUE 'set_secret';--> statement-breakpoint
CREATE TABLE "custom_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"type" "custom_field_type" NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_field_values" (
	"device_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"text_value" text,
	"date_value" text,
	"secret_ciphertext" "bytea",
	"secret_nonce" "bytea",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"action" "secret_action" NOT NULL,
	"success" boolean NOT NULL,
	"client_ip" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_field_history" ADD COLUMN "custom_field_id" uuid;--> statement-breakpoint
ALTER TABLE "device_field_values" ADD CONSTRAINT "device_field_values_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_field_values" ADD CONSTRAINT "device_field_values_field_id_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_fields"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_log" ADD CONSTRAINT "secret_access_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_log" ADD CONSTRAINT "secret_access_log_field_id_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_fields"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_fields_position_idx" ON "custom_fields" USING btree ("position");--> statement-breakpoint
CREATE UNIQUE INDEX "device_field_values_device_field_idx" ON "device_field_values" USING btree ("device_id","field_id");--> statement-breakpoint
CREATE INDEX "device_field_values_field_idx" ON "device_field_values" USING btree ("field_id");--> statement-breakpoint
CREATE INDEX "secret_access_log_device_idx" ON "secret_access_log" USING btree ("device_id","accessed_at");--> statement-breakpoint
ALTER TABLE "device_field_history" ADD CONSTRAINT "device_field_history_custom_field_id_custom_fields_id_fk" FOREIGN KEY ("custom_field_id") REFERENCES "public"."custom_fields"("id") ON DELETE no action ON UPDATE no action;