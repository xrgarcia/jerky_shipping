CREATE TABLE "feature_flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"description" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "feature_flags_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "shipping_methods" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"allow_rate_check" boolean DEFAULT true NOT NULL,
	"allow_assignment" boolean DEFAULT true NOT NULL,
	"allow_change" boolean DEFAULT true NOT NULL,
	"min_allowed_weight" numeric(10, 2),
	"max_allowed_weight" numeric(10, 2),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "shipping_methods_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "shipstation_write_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"patch_payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"next_retry_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"completed_at" timestamp,
	"local_shipment_id" text,
	"callback_action" text
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "requires_manual_package" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "package_assignment_error" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "rate_check_status" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "rate_check_attempted_at" timestamp;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "rate_check_error" text;--> statement-breakpoint
CREATE INDEX "feature_flags_key_idx" ON "feature_flags" USING btree ("key");--> statement-breakpoint
CREATE INDEX "shipping_methods_name_idx" ON "shipping_methods" USING btree ("name");--> statement-breakpoint
CREATE INDEX "ssw_queue_status_idx" ON "shipstation_write_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ssw_queue_shipment_idx" ON "shipstation_write_queue" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "ssw_queue_next_retry_idx" ON "shipstation_write_queue" USING btree ("next_retry_at");--> statement-breakpoint
CREATE INDEX "ssw_queue_status_created_idx" ON "shipstation_write_queue" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "shipments_rate_check_status_idx" ON "shipments" USING btree ("rate_check_status") WHERE "shipments"."rate_check_status" IS NOT NULL;