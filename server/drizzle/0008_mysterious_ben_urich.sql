CREATE TYPE "public"."staff_event_type" AS ENUM('login', 'login_denied', 'logout', 'it_pin_rotated', 'settings_changed', 'logo_changed');--> statement-breakpoint
CREATE TABLE "staff_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"staff_user_id" text,
	"hris_sub" text,
	"type" "staff_event_type" NOT NULL,
	"detail" text,
	"client_ip" text
);
--> statement-breakpoint
CREATE TABLE "staff_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "staff_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"hris_sub" text NOT NULL,
	"employee_number" text,
	"hris_user_level" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_user_email_unique" UNIQUE("email"),
	CONSTRAINT "staff_user_hris_sub_unique" UNIQUE("hris_sub")
);
--> statement-breakpoint
CREATE TABLE "staff_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "secret_access_log" ADD COLUMN "staff_user_id" text;--> statement-breakpoint
ALTER TABLE "staff_account" ADD CONSTRAINT "staff_account_user_id_staff_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_events" ADD CONSTRAINT "staff_events_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_session" ADD CONSTRAINT "staff_session_user_id_staff_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_account_user_idx" ON "staff_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staff_events_created_idx" ON "staff_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "staff_session_user_idx" ON "staff_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staff_verification_identifier_idx" ON "staff_verification" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "secret_access_log" ADD CONSTRAINT "secret_access_log_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;