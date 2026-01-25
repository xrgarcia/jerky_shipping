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
	"shipstation_resume_created_at" timestamp,
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desktop_clients" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"device_name" text NOT NULL,
	"access_token_hash" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"access_token_expires_at" timestamp NOT NULL,
	"refresh_token_expires_at" timestamp NOT NULL,
	"last_ip" text,
	"last_active_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desktop_config" (
	"id" varchar PRIMARY KEY DEFAULT 'global' NOT NULL,
	"connection_timeout" integer DEFAULT 15000 NOT NULL,
	"base_reconnect_delay" integer DEFAULT 2000 NOT NULL,
	"max_reconnect_delay" integer DEFAULT 30000 NOT NULL,
	"heartbeat_interval" integer DEFAULT 30000 NOT NULL,
	"reconnect_interval" integer DEFAULT 5000 NOT NULL,
	"token_refresh_interval" integer DEFAULT 3600000 NOT NULL,
	"offline_timeout" integer DEFAULT 1000 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar
);
--> statement-breakpoint
CREATE TABLE "excluded_explosion_skus" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "excluded_explosion_skus_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "fingerprint_models" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint_id" varchar NOT NULL,
	"packaging_type_id" varchar NOT NULL,
	"confidence" text DEFAULT 'manual',
	"created_by" varchar NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fingerprints" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signature" text NOT NULL,
	"signature_hash" text NOT NULL,
	"display_name" text,
	"total_items" integer NOT NULL,
	"collection_count" integer NOT NULL,
	"total_weight" real,
	"weight_unit" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fingerprints_signature_unique" UNIQUE("signature"),
	CONSTRAINT "fingerprints_signature_hash_unique" UNIQUE("signature_hash")
);
--> statement-breakpoint
CREATE TABLE "fulfillment_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text,
	"sequence_number" integer,
	"station_id" varchar,
	"station_type" text NOT NULL,
	"order_count" integer DEFAULT 0 NOT NULL,
	"max_orders" integer DEFAULT 28 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ready_at" timestamp,
	"picking_started_at" timestamp,
	"packing_started_at" timestamp,
	"completed_at" timestamp,
	"created_by" varchar
);
--> statement-breakpoint
CREATE TABLE "kit_component_mappings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kit_sku" text NOT NULL,
	"component_sku" text NOT NULL,
	"component_quantity" integer DEFAULT 1 NOT NULL,
	"synced_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "packaging_types" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"package_code" text,
	"dimension_length" text,
	"dimension_width" text,
	"dimension_height" text,
	"dimension_unit" text DEFAULT 'inch',
	"station_type" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "packaging_types_name_unique" UNIQUE("name")
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
	"station" text,
	"station_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" varchar NOT NULL,
	"printer_id" varchar,
	"order_id" varchar,
	"shipment_id" varchar,
	"job_type" text DEFAULT 'label' NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"error_message" text,
	"requested_by" varchar,
	"sent_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "printers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" varchar,
	"name" text NOT NULL,
	"system_name" text NOT NULL,
	"printer_type" text DEFAULT 'label' NOT NULL,
	"capabilities" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_collection_mappings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_collection_id" varchar NOT NULL,
	"sku" text NOT NULL,
	"created_by" varchar NOT NULL,
	"updated_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_collections" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"incremental_quantity" integer,
	"product_category" text,
	"created_by" varchar NOT NULL,
	"updated_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"page" text NOT NULL,
	"config" jsonb NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"station_id" text,
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
	"sv_product_id" integer,
	"expected_quantity" integer,
	"scanned_quantity" integer DEFAULT 0,
	"sv_picked" boolean,
	"sv_completed" boolean,
	"sv_audit_status" text,
	"sv_warehouse_location" text,
	"sv_warehouse_locations" jsonb,
	"sv_stock_status" text,
	"sv_available_quantity" integer,
	"sv_not_found_product" boolean,
	"sv_is_serialized" boolean,
	"sv_part_number" text,
	"sv_weight_pounds" text,
	"sv_code" text,
	"sv_product_pictures" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_packages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" varchar NOT NULL,
	"shipment_package_id" text,
	"package_id" text,
	"package_code" text,
	"package_name" text,
	"external_package_id" text,
	"content_description" text,
	"weight_value" text,
	"weight_unit" text,
	"dimension_length" text,
	"dimension_width" text,
	"dimension_height" text,
	"dimension_unit" text,
	"insured_amount" text,
	"insured_currency" text,
	"label_reference1" text,
	"label_reference2" text,
	"label_reference3" text,
	"products" jsonb,
	"dangerous_goods_info" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_qc_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" varchar NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"description" text,
	"image_url" text,
	"quantity_expected" integer DEFAULT 1 NOT NULL,
	"quantity_scanned" integer DEFAULT 0 NOT NULL,
	"collection_id" varchar,
	"synced_to_skuvault" boolean DEFAULT false NOT NULL,
	"is_kit_component" boolean DEFAULT false NOT NULL,
	"parent_sku" text,
	"weight_value" real,
	"weight_unit" text,
	"physical_location" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_rate_analysis" (
	"shipment_id" text PRIMARY KEY NOT NULL,
	"customer_shipping_method" text,
	"customer_shipping_cost" numeric(10, 2),
	"customer_delivery_days" integer,
	"smart_shipping_method" text,
	"smart_shipping_cost" numeric(10, 2),
	"smart_delivery_days" integer,
	"cost_savings" numeric(10, 2),
	"reasoning" text,
	"rates_compared_count" integer,
	"carrier_code" text,
	"service_code" text,
	"origin_postal_code" text DEFAULT '73108' NOT NULL,
	"destination_postal_code" text,
	"destination_state" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_sync_failures" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipstation_shipment_id" text,
	"modified_at" text,
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
	"shipment_id" text NOT NULL,
	"order_number" text NOT NULL,
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
	"session_id" text,
	"sessioned_at" timestamp,
	"wave_id" text,
	"sale_id" text,
	"firestore_document_id" text,
	"session_status" text,
	"spot_number" text,
	"picked_by_user_id" text,
	"picked_by_user_name" text,
	"pick_started_at" timestamp,
	"pick_ended_at" timestamp,
	"saved_custom_field_2" boolean,
	"reverse_sync_last_checked_at" timestamp,
	"last_shipstation_sync_at" timestamp,
	"shipstation_modified_at" timestamp,
	"cache_warmed_at" timestamp,
	"qc_completed" boolean DEFAULT false,
	"qc_completed_at" timestamp,
	"qc_station_id" varchar,
	"fingerprint_id" varchar,
	"packaging_type_id" varchar,
	"assigned_station_id" varchar,
	"packaging_decision_type" text,
	"fingerprint_status" text,
	"lifecycle_phase" text,
	"decision_subphase" text,
	"lifecycle_phase_changed_at" timestamp,
	"fulfillment_session_id" integer,
	"smart_session_spot" integer,
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
CREATE TABLE "shopify_product_variants" (
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
CREATE TABLE "shopify_products" (
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
CREATE TABLE "skuvault_products" (
	"sku" text PRIMARY KEY NOT NULL,
	"stock_check_date" timestamp NOT NULL,
	"product_title" text,
	"barcode" text,
	"product_category" text,
	"is_assembled_product" boolean DEFAULT false NOT NULL,
	"unit_cost" text,
	"product_image_url" text,
	"weight_value" real,
	"weight_unit" text,
	"parent_sku" text,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"available_quantity" integer DEFAULT 0 NOT NULL,
	"physical_location" text,
	"brand" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slashbin_kit_component_mappings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kit_sku" text NOT NULL,
	"component_sku" text NOT NULL,
	"component_quantity" integer DEFAULT 1 NOT NULL,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slashbin_order_items" (
	"order_number" varchar NOT NULL,
	"sku" text NOT NULL,
	"product_name" text,
	"qty" integer,
	"fulfillment_status" text,
	"price" numeric(10, 2),
	"product_brand" text,
	"weight" numeric(10, 2),
	"tax" numeric(10, 2),
	"subtotal" numeric(10, 2),
	"product_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slashbin_order_items_order_number_sku_pk" PRIMARY KEY("order_number","sku")
);
--> statement-breakpoint
CREATE TABLE "slashbin_orders" (
	"order_number" varchar PRIMARY KEY NOT NULL,
	"order_total" numeric(10, 2),
	"order_date" timestamp,
	"buyer_email" text,
	"tax_total" numeric(10, 2),
	"sub_total" numeric(10, 2),
	"shipping_cost" numeric(10, 2),
	"discount_total" numeric(10, 2),
	"tags" text,
	"refund_total" numeric(10, 2),
	"notes" text,
	"shipping_method" text,
	"order_status" text,
	"sales_channel" text,
	"shipping_first_name" text,
	"shipping_last_name" text,
	"shipping_address1" text,
	"shipping_address2" text,
	"shipping_city" text,
	"shipping_province" text,
	"shipping_province_code" text,
	"shipping_zip" text,
	"shipping_country" text,
	"shipping_country_code" text,
	"shipping_phone" text,
	"shipping_company" text,
	"customer_id" text,
	"customer_email" text,
	"customer_first_name" text,
	"customer_last_name" text,
	"customer_phone" text,
	"customer_created_at" timestamp,
	"customer_currency" text,
	"customer_province" text,
	"customer_country" text,
	"customer_address1" text,
	"customer_city" text,
	"customer_zip" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"desktop_client_id" varchar NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"location_hint" text,
	"station_type" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"id" varchar PRIMARY KEY NOT NULL,
	"cursor_value" text NOT NULL,
	"last_synced_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"handle" text,
	"avatar_url" text,
	"profile_background_color" text,
	"skuvault_username" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "web_packing_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"station_id" varchar NOT NULL,
	"selected_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desktop_clients" ADD CONSTRAINT "desktop_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_config" ADD CONSTRAINT "desktop_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fingerprint_models" ADD CONSTRAINT "fingerprint_models_fingerprint_id_fingerprints_id_fk" FOREIGN KEY ("fingerprint_id") REFERENCES "public"."fingerprints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fingerprint_models" ADD CONSTRAINT "fingerprint_models_packaging_type_id_packaging_types_id_fk" FOREIGN KEY ("packaging_type_id") REFERENCES "public"."packaging_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fingerprint_models" ADD CONSTRAINT "fingerprint_models_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_sessions" ADD CONSTRAINT "fulfillment_sessions_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_sessions" ADD CONSTRAINT "fulfillment_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_logs" ADD CONSTRAINT "packing_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_logs" ADD CONSTRAINT "packing_logs_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_queue" ADD CONSTRAINT "print_queue_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_collection_mappings" ADD CONSTRAINT "product_collection_mappings_product_collection_id_product_collections_id_fk" FOREIGN KEY ("product_collection_id") REFERENCES "public"."product_collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_collection_mappings" ADD CONSTRAINT "product_collection_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_collection_mappings" ADD CONSTRAINT "product_collection_mappings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_collections" ADD CONSTRAINT "product_collections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_collections" ADD CONSTRAINT "product_collections_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_packages" ADD CONSTRAINT "shipment_packages_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_qc_items" ADD CONSTRAINT "shipment_qc_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_qc_items" ADD CONSTRAINT "shipment_qc_items_collection_id_product_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."product_collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_tags" ADD CONSTRAINT "shipment_tags_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_product_variants" ADD CONSTRAINT "shopify_product_variants_product_id_shopify_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shopify_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slashbin_order_items" ADD CONSTRAINT "slashbin_order_items_order_number_slashbin_orders_order_number_fk" FOREIGN KEY ("order_number") REFERENCES "public"."slashbin_orders"("order_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_sessions" ADD CONSTRAINT "station_sessions_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_sessions" ADD CONSTRAINT "station_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_sessions" ADD CONSTRAINT "station_sessions_desktop_client_id_desktop_clients_id_fk" FOREIGN KEY ("desktop_client_id") REFERENCES "public"."desktop_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_packing_sessions" ADD CONSTRAINT "web_packing_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_packing_sessions" ADD CONSTRAINT "web_packing_sessions_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backfill_jobs_status_idx" ON "backfill_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "backfill_jobs_created_at_idx" ON "backfill_jobs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "desktop_clients_user_id_idx" ON "desktop_clients" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_clients_access_token_hash_idx" ON "desktop_clients" USING btree ("access_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_clients_refresh_token_hash_idx" ON "desktop_clients" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "excluded_explosion_skus_sku_idx" ON "excluded_explosion_skus" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "fingerprint_models_fingerprint_id_idx" ON "fingerprint_models" USING btree ("fingerprint_id");--> statement-breakpoint
CREATE INDEX "fingerprint_models_packaging_type_id_idx" ON "fingerprint_models" USING btree ("packaging_type_id");--> statement-breakpoint
CREATE INDEX "fingerprints_signature_hash_idx" ON "fingerprints" USING btree ("signature_hash");--> statement-breakpoint
CREATE INDEX "fingerprints_total_items_idx" ON "fingerprints" USING btree ("total_items");--> statement-breakpoint
CREATE INDEX "fulfillment_sessions_station_type_idx" ON "fulfillment_sessions" USING btree ("station_type");--> statement-breakpoint
CREATE INDEX "fulfillment_sessions_station_id_idx" ON "fulfillment_sessions" USING btree ("station_id") WHERE "fulfillment_sessions"."station_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "fulfillment_sessions_status_idx" ON "fulfillment_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fulfillment_sessions_created_at_idx" ON "fulfillment_sessions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kit_component_mappings_kit_sku_idx" ON "kit_component_mappings" USING btree ("kit_sku");--> statement-breakpoint
CREATE INDEX "kit_component_mappings_component_sku_idx" ON "kit_component_mappings" USING btree ("component_sku");--> statement-breakpoint
CREATE INDEX "kit_component_mappings_unique_idx" ON "kit_component_mappings" USING btree ("kit_sku","component_sku");--> statement-breakpoint
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
CREATE INDEX "packaging_types_name_idx" ON "packaging_types" USING btree ("name");--> statement-breakpoint
CREATE INDEX "packaging_types_station_type_idx" ON "packaging_types" USING btree ("station_type");--> statement-breakpoint
CREATE INDEX "packing_logs_shipment_id_idx" ON "packing_logs" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "packing_logs_user_id_idx" ON "packing_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "packing_logs_order_number_idx" ON "packing_logs" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "packing_logs_created_at_idx" ON "packing_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "packing_logs_station_idx" ON "packing_logs" USING btree ("station");--> statement-breakpoint
CREATE INDEX "print_jobs_station_id_idx" ON "print_jobs" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "print_jobs_printer_id_idx" ON "print_jobs" USING btree ("printer_id");--> statement-breakpoint
CREATE INDEX "print_jobs_order_id_idx" ON "print_jobs" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "print_jobs_shipment_id_idx" ON "print_jobs" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "print_jobs_status_idx" ON "print_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "print_jobs_requested_by_idx" ON "print_jobs" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "print_jobs_pending_idx" ON "print_jobs" USING btree ("station_id","priority" DESC NULLS LAST,"created_at") WHERE "print_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "print_queue_status_queued_at_idx" ON "print_queue" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "printers_station_id_idx" ON "printers" USING btree ("station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "printers_system_name_idx" ON "printers" USING btree ("system_name");--> statement-breakpoint
CREATE INDEX "product_collection_mappings_collection_id_idx" ON "product_collection_mappings" USING btree ("product_collection_id");--> statement-breakpoint
CREATE INDEX "product_collection_mappings_sku_idx" ON "product_collection_mappings" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "product_collections_name_idx" ON "product_collections" USING btree ("name");--> statement-breakpoint
CREATE INDEX "saved_views_user_id_page_idx" ON "saved_views" USING btree ("user_id","page");--> statement-breakpoint
CREATE INDEX "saved_views_is_public_idx" ON "saved_views" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "shipment_events_occurred_at_idx" ON "shipment_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "shipment_events_order_number_idx" ON "shipment_events" USING btree ("order_number") WHERE "shipment_events"."order_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_events_event_name_idx" ON "shipment_events" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX "shipment_events_username_idx" ON "shipment_events" USING btree ("username");--> statement-breakpoint
CREATE INDEX "shipment_events_station_id_idx" ON "shipment_events" USING btree ("station_id") WHERE "shipment_events"."station_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_events_timing_idx" ON "shipment_events" USING btree ("order_number","username","event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "shipment_events_station_timing_idx" ON "shipment_events" USING btree ("occurred_at","station_id") WHERE "shipment_events"."station_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_items_shipment_id_idx" ON "shipment_items" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_items_order_item_id_idx" ON "shipment_items" USING btree ("order_item_id") WHERE "shipment_items"."order_item_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_items_sku_idx" ON "shipment_items" USING btree ("sku") WHERE "shipment_items"."sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_items_external_order_item_id_idx" ON "shipment_items" USING btree ("external_order_item_id") WHERE "shipment_items"."external_order_item_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_items_sv_product_id_idx" ON "shipment_items" USING btree ("sv_product_id") WHERE "shipment_items"."sv_product_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_packages_shipment_id_idx" ON "shipment_packages" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_packages_shipment_package_id_idx" ON "shipment_packages" USING btree ("shipment_package_id") WHERE "shipment_packages"."shipment_package_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_packages_package_id_idx" ON "shipment_packages" USING btree ("package_id") WHERE "shipment_packages"."package_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_packages_package_name_idx" ON "shipment_packages" USING btree ("package_name") WHERE "shipment_packages"."package_name" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_qc_items_shipment_sku_unique" ON "shipment_qc_items" USING btree ("shipment_id","sku");--> statement-breakpoint
CREATE INDEX "shipment_qc_items_shipment_id_idx" ON "shipment_qc_items" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_qc_items_sku_idx" ON "shipment_qc_items" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "shipment_qc_items_barcode_idx" ON "shipment_qc_items" USING btree ("barcode") WHERE "shipment_qc_items"."barcode" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_qc_items_collection_id_idx" ON "shipment_qc_items" USING btree ("collection_id") WHERE "shipment_qc_items"."collection_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipment_qc_items_synced_idx" ON "shipment_qc_items" USING btree ("synced_to_skuvault");--> statement-breakpoint
CREATE INDEX "shipment_rate_analysis_cost_savings_idx" ON "shipment_rate_analysis" USING btree ("cost_savings" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shipment_rate_analysis_destination_state_idx" ON "shipment_rate_analysis" USING btree ("destination_state");--> statement-breakpoint
CREATE INDEX "shipment_rate_analysis_smart_method_idx" ON "shipment_rate_analysis" USING btree ("smart_shipping_method");--> statement-breakpoint
CREATE INDEX "shipment_rate_analysis_created_at_idx" ON "shipment_rate_analysis" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shipment_sync_failures_order_number_idx" ON "shipment_sync_failures" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "shipment_sync_failures_failed_at_idx" ON "shipment_sync_failures" USING btree ("failed_at");--> statement-breakpoint
CREATE INDEX "shipment_sync_failures_shipment_id_idx" ON "shipment_sync_failures" USING btree ("shipstation_shipment_id");--> statement-breakpoint
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
CREATE INDEX "shipments_session_id_idx" ON "shipments" USING btree ("session_id") WHERE "shipments"."session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_sessioned_at_idx" ON "shipments" USING btree ("sessioned_at" DESC NULLS LAST) WHERE "shipments"."sessioned_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_packing_queue_idx" ON "shipments" USING btree ("session_status","tracking_number") WHERE "shipments"."session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_last_shipstation_sync_at_idx" ON "shipments" USING btree ("last_shipstation_sync_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shipments_shipment_status_idx" ON "shipments" USING btree ("shipment_status") WHERE "shipments"."shipment_status" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_cache_warmer_ready_idx" ON "shipments" USING btree ("updated_at" DESC NULLS LAST) WHERE "shipments"."session_status" = 'closed' AND "shipments"."tracking_number" IS NULL AND "shipments"."ship_date" IS NULL;--> statement-breakpoint
CREATE INDEX "shipments_session_status_updated_at_idx" ON "shipments" USING btree ("session_status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shipments_cache_warmed_at_idx" ON "shipments" USING btree ("cache_warmed_at" DESC NULLS LAST) WHERE "shipments"."cache_warmed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_status_ship_date_idx" ON "shipments" USING btree ("shipment_status","ship_date" DESC NULLS LAST) WHERE "shipments"."shipment_status" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_carrier_ship_date_idx" ON "shipments" USING btree ("carrier_code","ship_date" DESC NULLS LAST) WHERE "shipments"."carrier_code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_qc_completed_at_idx" ON "shipments" USING btree ("qc_completed_at" DESC NULLS LAST) WHERE "shipments"."qc_completed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_qc_station_id_idx" ON "shipments" USING btree ("qc_station_id") WHERE "shipments"."qc_station_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_fingerprint_id_idx" ON "shipments" USING btree ("fingerprint_id") WHERE "shipments"."fingerprint_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_packaging_type_id_idx" ON "shipments" USING btree ("packaging_type_id") WHERE "shipments"."packaging_type_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_assigned_station_id_idx" ON "shipments" USING btree ("assigned_station_id") WHERE "shipments"."assigned_station_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_packaging_decision_type_idx" ON "shipments" USING btree ("packaging_decision_type") WHERE "shipments"."packaging_decision_type" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_fingerprint_status_idx" ON "shipments" USING btree ("fingerprint_status") WHERE "shipments"."fingerprint_status" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_lifecycle_phase_idx" ON "shipments" USING btree ("lifecycle_phase") WHERE "shipments"."lifecycle_phase" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_decision_subphase_idx" ON "shipments" USING btree ("decision_subphase") WHERE "shipments"."decision_subphase" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_fulfillment_session_id_idx" ON "shipments" USING btree ("fulfillment_session_id") WHERE "shipments"."fulfillment_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shopify_order_sync_failures_order_number_idx" ON "shopify_order_sync_failures" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "shopify_order_sync_failures_failed_at_idx" ON "shopify_order_sync_failures" USING btree ("failed_at");--> statement-breakpoint
CREATE INDEX "shopify_product_variants_sku_idx" ON "shopify_product_variants" USING btree ("sku") WHERE "shopify_product_variants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "shopify_product_variants_bar_code_idx" ON "shopify_product_variants" USING btree ("bar_code") WHERE "shopify_product_variants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "skuvault_products_stock_check_date_idx" ON "skuvault_products" USING btree ("stock_check_date");--> statement-breakpoint
CREATE INDEX "skuvault_products_product_category_idx" ON "skuvault_products" USING btree ("product_category") WHERE "skuvault_products"."product_category" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "skuvault_products_is_assembled_product_idx" ON "skuvault_products" USING btree ("is_assembled_product");--> statement-breakpoint
CREATE INDEX "skuvault_products_barcode_idx" ON "skuvault_products" USING btree ("barcode") WHERE "skuvault_products"."barcode" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "skuvault_products_parent_sku_idx" ON "skuvault_products" USING btree ("parent_sku") WHERE "skuvault_products"."parent_sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "slashbin_kit_component_mappings_kit_sku_idx" ON "slashbin_kit_component_mappings" USING btree ("kit_sku");--> statement-breakpoint
CREATE INDEX "slashbin_kit_component_mappings_component_sku_idx" ON "slashbin_kit_component_mappings" USING btree ("component_sku");--> statement-breakpoint
CREATE INDEX "slashbin_kit_component_mappings_unique_idx" ON "slashbin_kit_component_mappings" USING btree ("kit_sku","component_sku");--> statement-breakpoint
CREATE INDEX "slashbin_order_items_order_number_idx" ON "slashbin_order_items" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "slashbin_order_items_sku_idx" ON "slashbin_order_items" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "slashbin_orders_order_date_idx" ON "slashbin_orders" USING btree ("order_date");--> statement-breakpoint
CREATE INDEX "slashbin_orders_order_status_idx" ON "slashbin_orders" USING btree ("order_status");--> statement-breakpoint
CREATE INDEX "slashbin_orders_buyer_email_idx" ON "slashbin_orders" USING btree ("buyer_email");--> statement-breakpoint
CREATE INDEX "station_sessions_station_id_idx" ON "station_sessions" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "station_sessions_user_id_idx" ON "station_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "station_sessions_desktop_client_id_idx" ON "station_sessions" USING btree ("desktop_client_id");--> statement-breakpoint
CREATE INDEX "station_sessions_status_idx" ON "station_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "station_sessions_active_station_idx" ON "station_sessions" USING btree ("station_id") WHERE "station_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "stations_name_idx" ON "stations" USING btree ("name");--> statement-breakpoint
CREATE INDEX "stations_is_active_idx" ON "stations" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "stations_station_type_idx" ON "stations" USING btree ("station_type");--> statement-breakpoint
CREATE INDEX "web_packing_sessions_user_id_idx" ON "web_packing_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "web_packing_sessions_station_id_idx" ON "web_packing_sessions" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "web_packing_sessions_expires_at_idx" ON "web_packing_sessions" USING btree ("expires_at");