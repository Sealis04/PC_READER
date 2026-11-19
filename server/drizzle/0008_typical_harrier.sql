CREATE TYPE "public"."recovery_key_action" AS ENUM('reveal', 'rotate');--> statement-breakpoint
CREATE TYPE "public"."recovery_key_source" AS ENUM('seed', 'auto', 'manual');--> statement-breakpoint
ALTER TYPE "public"."unlock_method" ADD VALUE 'reveal_recovery_key';--> statement-breakpoint
ALTER TYPE "public"."unlock_method" ADD VALUE 'rotate_recovery_key';--> statement-breakpoint
ALTER TYPE "public"."unlock_method" ADD VALUE 'server_move';--> statement-breakpoint
CREATE TABLE "recovery_key_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" "recovery_key_action" NOT NULL,
	"version" integer,
	"device_id" uuid,
	"success" boolean NOT NULL,
	"client_ip" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_keys" (
	"version" serial PRIMARY KEY NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"verify_hash" text NOT NULL,
	"pc_hash" jsonb NOT NULL,
	"source" "recovery_key_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "server_move_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"move_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"moved" boolean NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "server_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url" text NOT NULL,
	"client_ip" text,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "recovery_key_version" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "recovery_key_acked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recovery_key_access_log" ADD CONSTRAINT "recovery_key_access_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_move_results" ADD CONSTRAINT "server_move_results_move_id_server_moves_id_fk" FOREIGN KEY ("move_id") REFERENCES "public"."server_moves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_move_results" ADD CONSTRAINT "server_move_results_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recovery_key_access_log_accessed_idx" ON "recovery_key_access_log" USING btree ("accessed_at");--> statement-breakpoint
CREATE INDEX "server_move_results_move_idx" ON "server_move_results" USING btree ("move_id","device_id","created_at");