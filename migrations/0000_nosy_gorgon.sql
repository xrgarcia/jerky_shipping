CREATE TABLE "backfill_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"shopify_orders_total" integer DEFAULT 0 NOT NULL,
	"shopify_orders_imported" integer DEFAULT 0 NOT NULL,
	"shopify_orders_failed" integer DEFAULT 0 NOT NULL,
	"shipstation_shipments_total" integer DEFAULT 0 NOT NULL,
	"shipstation_shipments_imported" integer DEFAULT 0 NOT NULL,
	"shipstation_shipments_failed" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_link_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "magic_link_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" varchar NOT NULL,
	"shopify_line_item_id" varchar NOT NULL,
	"title" text NOT NULL,
	"sku" text,
	"variant_id" varchar,
	"product_id" varchar,
	"quantity" integer NOT NULL,
	"current_quantity" integer,
	"price" text DEFAULT '0' NOT NULL,
	"total_discount" text DEFAULT '0' NOT NULL,
	"price_set_json" jsonb,
	"total_discount_set_json" jsonb,
	"taxable" boolean,
	"tax_lines_json" jsonb,
	"requires_shipping" boolean,
	"price_set_amount" text DEFAULT '0' NOT NULL,
	"total_discount_set_amount" text DEFAULT '0' NOT NULL,
	"total_tax_amount" text DEFAULT '0' NOT NULL,
	"pre_discount_price" text DEFAULT '0' NOT NULL,
	"final_line_price" text DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_refunds" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" varchar NOT NULL,
	"shopify_refund_id" varchar NOT NULL,
	"amount" text NOT NULL,
	"note" text,
	"refunded_at" timestamp NOT NULL,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "order_refunds_shopify_refund_id_unique" UNIQUE("shopify_refund_id")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" varchar PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text,
	"customer_phone" text,
	"shipping_address" jsonb NOT NULL,
	"line_items" jsonb NOT NULL,
	"fulfillment_status" text,
	"financial_status" text,
	"total_price" text DEFAULT '0' NOT NULL,
	"order_total" text DEFAULT '0' NOT NULL,
	"total_line_items_price" text DEFAULT '0' NOT NULL,
	"subtotal_price" text DEFAULT '0' NOT NULL,
	"current_total_price" text DEFAULT '0' NOT NULL,
	"current_subtotal_price" text DEFAULT '0' NOT NULL,
	"shipping_total" text DEFAULT '0' NOT NULL,
	"total_discounts" text DEFAULT '0' NOT NULL,
	"current_total_discounts" text DEFAULT '0' NOT NULL,
	"total_tax" text DEFAULT '0' NOT NULL,
	"current_total_tax" text DEFAULT '0' NOT NULL,
	"total_additional_fees" text DEFAULT '0' NOT NULL,
	"current_total_additional_fees" text DEFAULT '0' NOT NULL,
	"total_outstanding" text DEFAULT '0' NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"last_synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packing_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"shipment_id" varchar NOT NULL,
	"order_number" text NOT NULL,
	"action" text NOT NULL,
	"product_sku" text,
	"scanned_code" text,
	"skuvault_product_id" text,
	"success" boolean NOT NULL,
	"error_message" text,
	"skuvault_raw_response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_queue" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" varchar NOT NULL,
	"label_url" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_retry_at" timestamp,
	"queued_at" timestamp DEFAULT now() NOT NULL,
	"printed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" varchar PRIMARY KEY NOT NULL,
	"product_id" varchar NOT NULL,
	"sku" text,
	"bar_code" text,
	"title" text NOT NULL,
	"image_url" text,
	"price" text NOT NULL,
	"inventory_quantity" integer DEFAULT 0 NOT NULL,
	"shopify_created_at" timestamp NOT NULL,
	"shopify_updated_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" varchar PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"image_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"shopify_created_at" timestamp NOT NULL,
	"shopify_updated_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_synced_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"username" text NOT NULL,
	"station" text NOT NULL,
	"event_name" text NOT NULL,
	"order_number" text,
	"metadata" jsonb,
	"skuvault_import" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" varchar NOT NULL,
	"order_item_id" varchar,
	"sku" text,
	"name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" text,
	"external_order_item_id" text,
	"image_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_sync_failures" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"reason" text NOT NULL,
	"error_message" text NOT NULL,
	"request_data" jsonb,
	"response_data" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"failed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_tags" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" varchar NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"tag_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" varchar,
	"shipment_id" text,
	"order_number" text,
	"tracking_number" text,
	"carrier_code" text,
	"service_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_description" text,
	"shipment_status" text,
	"label_url" text,
	"ship_date" timestamp,
	"estimated_delivery_date" timestamp,
	"actual_delivery_date" timestamp,
	"ship_to_name" text,
	"ship_to_phone" text,
	"ship_to_email" text,
	"ship_to_company" text,
	"ship_to_address_line1" text,
	"ship_to_address_line2" text,
	"ship_to_address_line3" text,
	"ship_to_city" text,
	"ship_to_state" text,
	"ship_to_postal_code" text,
	"ship_to_country" text,
	"ship_to_is_residential" text,
	"is_return" boolean,
	"is_gift" boolean,
	"notes_for_gift" text,
	"notes_from_buyer" text,
	"total_weight" text,
	"bill_to_account" text,
	"bill_to_country_code" text,
	"bill_to_party" text,
	"bill_to_postal_code" text,
	"bill_to_name" text,
	"bill_to_address_line1" text,
	"contains_alcohol" boolean,
	"delivered_duty_paid" boolean,
	"non_machinable" boolean,
	"saturday_delivery" boolean,
	"dry_ice" boolean,
	"dry_ice_weight" text,
	"fedex_freight" text,
	"third_party_consignee" boolean,
	"guaranteed_duties_and_taxes" boolean,
	"ancillary_endorsements_option" text,
	"freight_class" text,
	"custom_field1" text,
	"custom_field2" text,
	"custom_field3" text,
	"collect_on_delivery" text,
	"return_pickup_attempts" text,
	"additional_handling" boolean,
	"own_document_upload" boolean,
	"limited_quantity" boolean,
	"event_notification" boolean,
	"import_services" boolean,
	"override_holiday" boolean,
	"shipment_data" jsonb,
	"order_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_order_sync_failures" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"reason" text NOT NULL,
	"error_message" text NOT NULL,
	"request_data" jsonb,
	"response_data" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"failed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"handle" text,
	"avatar_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_logs" ADD CONSTRAINT "packing_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_logs" ADD CONSTRAINT "packing_logs_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_queue" ADD CONSTRAINT "print_queue_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_tags" ADD CONSTRAINT "shipment_tags_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backfill_jobs_status_idx" ON "backfill_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "backfill_jobs_created_at_idx" ON "backfill_jobs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "order_items_order_id_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_variant_id_idx" ON "order_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "order_items_product_id_idx" ON "order_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "order_items_sku_idx" ON "order_items" USING btree ("sku") WHERE "order_items"."sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "order_items_requires_shipping_idx" ON "order_items" USING btree ("order_id","requires_shipping");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_shopify_line_item_id_idx" ON "order_items" USING btree ("shopify_line_item_id");--> statement-breakpoint
CREATE INDEX "order_refunds_refunded_at_idx" ON "order_refunds" USING btree ("refunded_at");--> statement-breakpoint
CREATE INDEX "order_refunds_order_id_idx" ON "order_refunds" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_number_idx" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_updated_at_idx" ON "orders" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_fulfillment_status_created_at_idx" ON "orders" USING btree ("fulfillment_status","created_at");--> statement-breakpoint
CREATE INDEX "orders_financial_status_idx" ON "orders" USING btree ("financial_status");--> statement-breakpoint
CREATE INDEX "orders_last_synced_at_idx" ON "orders" USING btree ("last_synced_at");--> statement-breakpoint
CREATE INDEX "orders_order_number_trgm_idx" ON "orders" USING gin ("order_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "orders_customer_name_trgm_idx" ON "orders" USING gin ("customer_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "packing_logs_shipment_id_idx" ON "packing_logs" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "packing_logs_user_id_idx" ON "packing_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "packing_logs_created_at_idx" ON "packing_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "print_queue_status_queued_at_idx" ON "print_queue" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "product_variants_sku_idx" ON "product_variants" USING btree ("sku") WHERE "product_variants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "product_variants_bar_code_idx" ON "product_variants" USING btree ("bar_code") WHERE "product_variants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "shipment_events_occurred_at_idx" ON "shipment_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "shipment_events_order_number_idx" ON "shipment_events" USING btree ("order_number") WHERE "shipment_events"."order_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_events_event_name_idx" ON "shipment_events" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX "shipment_events_username_idx" ON "shipment_events" USING btree ("username");--> statement-breakpoint
CREATE INDEX "shipment_items_shipment_id_idx" ON "shipment_items" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_items_order_item_id_idx" ON "shipment_items" USING btree ("order_item_id") WHERE "shipment_items"."order_item_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_items_sku_idx" ON "shipment_items" USING btree ("sku") WHERE "shipment_items"."sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_items_external_order_item_id_idx" ON "shipment_items" USING btree ("external_order_item_id") WHERE "shipment_items"."external_order_item_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_sync_failures_order_number_idx" ON "shipment_sync_failures" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "shipment_sync_failures_failed_at_idx" ON "shipment_sync_failures" USING btree ("failed_at");--> statement-breakpoint
CREATE INDEX "shipment_tags_shipment_id_idx" ON "shipment_tags" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_tags_name_idx" ON "shipment_tags" USING btree ("name");--> statement-breakpoint
CREATE INDEX "shipments_order_number_idx" ON "shipments" USING btree ("order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_shipment_id_idx" ON "shipments" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_tracking_number_idx" ON "shipments" USING btree ("tracking_number") WHERE "shipments"."tracking_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_order_id_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_order_number_carrier_idx" ON "shipments" USING btree ("order_number","carrier_code") WHERE "shipments"."order_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_ship_date_idx" ON "shipments" USING btree ("ship_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shipments_status_idx" ON "shipments" USING btree ("status") WHERE "shipments"."status" IN ('delivered', 'in_transit', 'exception', 'pending');--> statement-breakpoint
CREATE INDEX "shipments_orphaned_idx" ON "shipments" USING btree ("created_at") WHERE "shipments"."order_id" IS NULL AND "shipments"."tracking_number" IS NULL;--> statement-breakpoint
CREATE INDEX "shopify_order_sync_failures_order_number_idx" ON "shopify_order_sync_failures" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "shopify_order_sync_failures_failed_at_idx" ON "shopify_order_sync_failures" USING btree ("failed_at");