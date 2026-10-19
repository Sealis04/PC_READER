CREATE TYPE "public"."unlock_method" AS ENUM('hourly_pin');--> statement-breakpoint
CREATE TABLE "it_pin_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"secret" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings_unlock_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"success" boolean NOT NULL,
	"method" "unlock_method" DEFAULT 'hourly_pin' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings_unlock_attempts" ADD CONSTRAINT "settings_unlock_attempts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settings_unlock_attempts_device_idx" ON "settings_unlock_attempts" USING btree ("device_id","attempted_at");