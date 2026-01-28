CREATE TABLE "lifecycle_repair_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"shipments_total" integer DEFAULT 0 NOT NULL,
	"shipments_repaired" integer DEFAULT 0 NOT NULL,
	"shipments_failed" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_analysis_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preset" text NOT NULL,
	"days_back" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"shipments_total" integer DEFAULT 0 NOT NULL,
	"shipments_analyzed" integer DEFAULT 0 NOT NULL,
	"shipments_failed" integer DEFAULT 0 NOT NULL,
	"savings_found" numeric DEFAULT '0',
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments_dead_letters" (
	"shipment_id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slashbin_order_items" DROP CONSTRAINT "slashbin_order_items_order_number_sku_pk";--> statement-breakpoint
ALTER TABLE "shipment_rate_analysis" ADD COLUMN "used_fallback_package_details" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "shipment_rate_analysis" ADD COLUMN "package_weight_oz" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "shipment_rate_analysis" ADD COLUMN "package_length_in" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "shipment_rate_analysis" ADD COLUMN "package_width_in" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "shipment_rate_analysis" ADD COLUMN "package_height_in" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "shipment_rate_analysis" ADD COLUMN "all_rates_checked" jsonb;--> statement-breakpoint
ALTER TABLE "skuvault_products" ADD COLUMN "pending_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skuvault_products" ADD COLUMN "allocated_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "slashbin_order_items" ADD COLUMN "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE INDEX "lifecycle_repair_jobs_status_idx" ON "lifecycle_repair_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "lifecycle_repair_jobs_created_at_idx" ON "lifecycle_repair_jobs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rate_analysis_jobs_status_idx" ON "rate_analysis_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rate_analysis_jobs_created_at_idx" ON "rate_analysis_jobs" USING btree ("created_at" DESC NULLS LAST);