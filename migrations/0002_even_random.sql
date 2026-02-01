ALTER TABLE "packaging_types" ADD COLUMN "package_id" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "shipping_cost" numeric(10, 2);--> statement-breakpoint
CREATE INDEX "packaging_types_package_id_idx" ON "packaging_types" USING btree ("package_id");--> statement-breakpoint
ALTER TABLE "packaging_types" ADD CONSTRAINT "packaging_types_package_id_unique" UNIQUE("package_id");