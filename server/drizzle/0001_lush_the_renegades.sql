CREATE TYPE "public"."connection_type" AS ENUM('ethernet', 'wifi', 'other');--> statement-breakpoint
CREATE TYPE "public"."log_category" AS ENUM('scan', 'sync', 'signup', 'update', 'system');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('error', 'warning', 'info');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('pending', 'delivered', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."request_type" AS ENUM('scan_now', 'send_logs', 'prompt_details_update');--> statement-breakpoint
CREATE TABLE "device_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"local_entry_id" bigint NOT NULL,
	"logged_at" timestamp with time zone NOT NULL,
	"level" "log_level" NOT NULL,
	"category" "log_category" NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"type" "request_type" NOT NULL,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"scan_id" uuid,
	"message" text,
	"requested_by" text
);
--> statement-breakpoint
CREATE TABLE "network_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"ip_addresses" text[] NOT NULL,
	"mac_addresses" text[] NOT NULL,
	"gateway" text,
	"dns_servers" text[] NOT NULL,
	"connection_type" "connection_type" NOT NULL,
	"ssid" text,
	"online" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "agent_version" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "online" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_logs" ADD CONSTRAINT "device_logs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_requests" ADD CONSTRAINT "device_requests_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_requests" ADD CONSTRAINT "device_requests_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_logs" ADD CONSTRAINT "network_logs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_logs_entry_idx" ON "device_logs" USING btree ("device_id","local_entry_id");--> statement-breakpoint
CREATE INDEX "device_logs_device_logged_idx" ON "device_logs" USING btree ("device_id","logged_at");--> statement-breakpoint
CREATE INDEX "device_requests_device_idx" ON "device_requests" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "device_requests_open_idx" ON "device_requests" USING btree ("device_id","type") WHERE "device_requests"."status" in ('pending', 'delivered');--> statement-breakpoint
CREATE INDEX "network_logs_device_collected_idx" ON "network_logs" USING btree ("device_id","collected_at");--> statement-breakpoint
CREATE INDEX "devices_last_seen_idx" ON "devices" USING btree ("last_seen_at");