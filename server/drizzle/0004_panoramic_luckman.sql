ALTER TYPE "public"."unlock_method" ADD VALUE 'register';--> statement-breakpoint
ALTER TYPE "public"."unlock_method" ADD VALUE 'update_details';--> statement-breakpoint
ALTER TYPE "public"."unlock_method" ADD VALUE 'manual_scan';--> statement-breakpoint
ALTER TABLE "settings_unlock_attempts" ALTER COLUMN "device_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "settings_unlock_attempts" ADD COLUMN "client_ip" text;--> statement-breakpoint
CREATE INDEX "settings_unlock_attempts_ip_idx" ON "settings_unlock_attempts" USING btree ("client_ip","attempted_at");