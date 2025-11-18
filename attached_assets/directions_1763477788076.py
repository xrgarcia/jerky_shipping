"""SkuVault directions API response models.

This module contains Pydantic models for the SkuVault directions API response,
which provides detailed information about SKU locations, spot numbers, and
picking directions for a specific session.

All fields are optional to handle variations in the API response structure.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class LocationInfo(BaseModel):
    """Location information for a product."""

    warehouse_id: Optional[int] = Field(None, alias="warehouseId")
    warehouse_code: Optional[str] = Field(None, alias="warehouseCode")
    name: Optional[str] = None
    container_id: Optional[int] = Field(None, alias="containerId")
    lot_id: Optional[int] = Field(None, alias="lotId")
    lot_number: Optional[str] = Field(None, alias="lotNumber")
    quantity: Optional[float] = None
    missing: Optional[bool] = None
    create_date: Optional[datetime] = Field(None, alias="createDate")
    expired_date: Optional[datetime] = Field(None, alias="expiredDate")
    first_received_date: Optional[datetime] = Field(None, alias="firstReceivedDate")


class OrderItem(BaseModel):
    """Individual item within an order."""

    product_id: Optional[int] = Field(None, alias="productId")
    quantity: Optional[float] = None
    sku: Optional[str] = None
    part_number: Optional[str] = Field(None, alias="partNumber")
    code: Optional[str] = None
    description: Optional[str] = None
    product_pictures: Optional[List[str]] = Field(None, alias="productPictures")
    weight_pound: Optional[float] = Field(None, alias="weightPound")
    locations: Optional[List[LocationInfo]] = None
    location: Optional[str] = None
    available: Optional[float] = None
    picked: Optional[float] = None
    not_found_product: Optional[bool] = Field(None, alias="notFoundProduct")
    completed: Optional[bool] = None
    is_serialized: Optional[bool] = Field(None, alias="isSerialized")
    audit_status: Optional[str] = Field(None, alias="auditStatus")
    stock_status: Optional[str] = Field(None, alias="stockStatus")


class Order(BaseModel):
    """Order information within a picklist."""

    id: Optional[str] = None
    items: Optional[List[OrderItem]] = None


class BinInfo(BaseModel):
    """Bin information for the picklist."""

    # Add bin-related fields as they appear in the API response
    pass


class AssignedUser(BaseModel):
    """User assigned to the picklist."""

    user_id: Optional[int] = Field(None, alias="userId")
    name: Optional[str] = None


class PicklistInfo(BaseModel):
    """Main picklist information."""

    orders: Optional[List[Order]] = None
    bins: Optional[List[BinInfo]] = None
    skip_not_counted_location: Optional[bool] = Field(
        None, alias="skipNotcountedLocation"
    )
    skip_secondary_location: Optional[bool] = Field(None, alias="skipSecondaryLocation")
    contains_nfp: Optional[bool] = Field(None, alias="containsNFP")
    picklist_id: Optional[str] = Field(None, alias="picklistId")
    date: Optional[datetime] = None
    sequence_id: Optional[int] = Field(None, alias="sequenceId")
    state: Optional[str] = None
    cart: Optional[Any] = None
    constrain_by_warehouses: Optional[List[Any]] = Field(
        None, alias="constrainByWarehouses"
    )
    sku_count: Optional[int] = Field(None, alias="skuCount")
    order_count: Optional[int] = Field(None, alias="orderCount")
    bins_count: Optional[int] = Field(None, alias="binsCount")
    order_items: Optional[int] = Field(None, alias="orderItems")
    order_items_completed: Optional[int] = Field(None, alias="orderItemsCompleted")
    available_quantity: Optional[float] = Field(None, alias="availableQuantity")
    total_quantity: Optional[float] = Field(None, alias="totalQuantity")
    total_items_weight: Optional[float] = Field(None, alias="totalItemsWeight")
    picked_quantity: Optional[float] = Field(None, alias="pickedQuantity")
    remaining_quantity: Optional[float] = Field(None, alias="remainingQuantity")
    unavailable_quantity: Optional[float] = Field(None, alias="unavailableQuantity")
    assigned: Optional[AssignedUser] = None
    can_assign: Optional[bool] = Field(None, alias="canAssign")
    can_start: Optional[bool] = Field(None, alias="canStart")
    can_stop: Optional[bool] = Field(None, alias="canStop")
    can_pick: Optional[bool] = Field(None, alias="canPick")
    can_close: Optional[bool] = Field(None, alias="canClose")
    can_assign_cart: Optional[bool] = Field(None, alias="canAssignCart")
    can_complete: Optional[bool] = Field(None, alias="canComplete")


class HistoryItem(BaseModel):
    """Individual history item for picking actions."""

    date: Optional[datetime] = None
    type: Optional[str] = None
    current_bin_id: Optional[int] = Field(None, alias="currentBinId")
    quantity: Optional[float] = None
    product_sku: Optional[str] = Field(None, alias="productSku")
    product_description: Optional[str] = Field(None, alias="productDescription")
    warehouse_id: Optional[int] = Field(None, alias="warehouseId")
    location_code: Optional[str] = Field(None, alias="locationCode")
    container_id: Optional[int] = Field(None, alias="containerId")
    lot_id: Optional[int] = Field(None, alias="lotId")
    sale_id: Optional[str] = Field(None, alias="saleId")
    container_drill_down: Optional[Any] = Field(None, alias="containerDrillDown")
    code: Optional[str] = None
    part_number: Optional[str] = Field(None, alias="partNumber")
    product_pictures: Optional[List[str]] = Field(None, alias="productPictures")
    current_bin_code: Optional[str] = Field(None, alias="currentBinCode")
    spot_id: Optional[int] = Field(None, alias="spotId")
    lot_number: Optional[str] = Field(None, alias="lotNumber")
    serial_numbers: Optional[List[str]] = Field(None, alias="serialNumbers")
    is_serialized: Optional[bool] = Field(None, alias="isSerialized")


class DirectionItem(BaseModel):
    """Individual direction item for picking."""

    # This will be populated based on actual API response structure
    # For now, using a flexible approach
    pass


class DirectionsResponse(BaseModel):
    """Complete response from the SkuVault directions API."""

    picklist: Optional[PicklistInfo] = None
    directions: Optional[List[DirectionItem]] = None
    history: Optional[List[HistoryItem]] = None


class ParsedDirection(BaseModel):
    """Parsed and simplified direction data for easy consumption."""

    picklist_id: Optional[str] = None
    sku: Optional[str] = None
    sku_name: Optional[str] = None
    location: Optional[str] = None
    spot_number: Optional[int] = Field(
        None, description="1-based index of the order in the orders array"
    )
    bin_info: Optional[str] = None
    quantity: Optional[float] = None
    order_number: Optional[str] = None
    order_line: Optional[int] = None
    warehouse: Optional[str] = None
    zone: Optional[str] = None
    aisle: Optional[str] = None
    rack: Optional[str] = None
    level: Optional[str] = None
    position: Optional[str] = None
    extracted_at: Optional[float] = None
