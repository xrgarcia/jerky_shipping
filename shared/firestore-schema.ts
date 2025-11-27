export interface SkuVaultOrderSessionItem {
  audit_status: string | null;
  available: number | null;
  code: string | null;
  completed: boolean | null;
  description: string | null;
  is_serialized: boolean | null;
  location: string | null;
  locations: string[] | null;
  not_found_product: boolean | null;
  part_number: string | null;
  picked: boolean | null;
  product_id: number | null;
  product_pictures: string[] | null;
  quantity: number;
  sku: string;
  stock_status: string | null;
  weight_pound: number | null;
}

export interface SkuVaultOrderSession {
  document_id: string;
  order_number: string;
  session_id: number;
  shipment_id: string;
  sale_id: string;
  session_picklist_id: string;
  session_status: string;
  spot_number: number;
  picked_by_user_id: number;
  picked_by_user_name: string;
  pick_start_datetime: Date;
  pick_end_datetime: Date;
  create_date: Date;
  updated_date: Date;
  saved_custom_field_2: boolean;
  order_items: SkuVaultOrderSessionItem[];
}

export interface SkuVaultOrderSessionFilters {
  search?: string;
  pickerName?: string;
  sessionStatus?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}
