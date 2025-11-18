"""SkuVault session data models.

This module defines the data models for SkuVault wave picking sessions,
including the API response structure and parsed session data.

Example:
    ```python
    from jerky_data_hub.models.skuvault.sessions import ParsedSession

    session = ParsedSession(
        session_id=12345,
        picklist_id="uuid-string",
        status=SessionState.ACTIVE
    )
    ```
"""

from datetime import datetime
from enum import Enum
from typing import List, Optional, Union

import pytz
from pydantic import BaseModel, field_validator

from jerky_data_hub.models.logging import LogContext
from jerky_data_hub.models.skuvault.directions import OrderItem
from jerky_data_hub.services.cloud_logging_service import CloudLoggingService

# Configure logging
logger = CloudLoggingService("SessionOrder")


class SessionState(Enum):
    """Valid session states for SkuVault wave picking.

    These states represent the lifecycle of a wave picking session
    from creation through completion.
    """

    ACTIVE = "active"
    INACTIVE = "inactive"
    NEW = "new"
    READY_TO_SHIP = "readyToShip"
    CLOSED = "closed"


class AssignedUser(BaseModel):
    """User assigned to a wave picking session."""

    name: Optional[str] = None
    userId: Optional[str] = None

    @field_validator("userId", mode="before")
    @classmethod
    def convert_user_id_to_string(cls, v: Union[int, str, None]) -> Union[str, None]:
        """Convert userId to string if it's an integer."""
        if isinstance(v, int):
            return str(v)
        return v


class SessionData(BaseModel):
    """Raw session data from the SkuVault API."""

    sequenceId: Optional[int] = None
    picklistId: Optional[str] = None
    state: Optional[str] = None
    date: Optional[str] = None
    assigned: Optional[AssignedUser] = None
    skuCount: Optional[int] = None
    orderCount: Optional[int] = None
    totalQuantity: Optional[float] = None
    pickedQuantity: Optional[float] = None
    availableQuantity: Optional[float] = None
    totalItemsWeight: Optional[float] = None


class SessionsResponse(BaseModel):
    """Response model for the sessions API endpoint."""

    lists: Optional[List[SessionData]] = None


class SessionOrder(BaseModel):
    """Simplified order with only key fields."""

    sale_id: Optional[str] = None
    order_number: Optional[str] = None  # Marketplace order ID
    spot_number: Optional[int] = None
    session_picklist_id: Optional[str] = None
    session_id: Optional[int] = None
    create_date: Optional[datetime] = None  # When session order was created
    pick_start_datetime: Optional[datetime] = None  # When picking started
    pick_end_datetime: Optional[datetime] = None  # When picking ended
    order_items: List[OrderItem] = []
    document_id: Optional[str] = None  # Firestore doc ID
    picked_by_user_id: Optional[int] = None  # User ID who picked this order
    picked_by_user_name: Optional[str] = None  # User name who picked this order
    session_status: Optional[SessionState] = None  # Status of parent session
    # Flag indicating custom field 2 has been saved to ShipStation shipment
    saved_custom_field_2: bool = False
    # ShipStation shipment ID for tracking and reference (string format like 'se-123456')
    shipment_id: Optional[str] = None
    # Timestamp when this session order was last updated (Firestore server timestamp)
    updated_date: Optional[datetime] = None

    @classmethod
    def get_current_us_central_time(cls) -> datetime:
        """Get current time in US Central timezone.

        Returns:
            Current datetime in US Central timezone

        Example:
            ```python
            current_time = SessionOrder.get_current_us_central_time()
            print(f"Current US Central time: {current_time}")
            ```
        """
        us_central = pytz.timezone('US/Central')
        return datetime.now(us_central)

    def set_updated_date_to_now(self) -> None:
        """Set the updated_date to current US Central time.

        This method should be called whenever the session order is modified
        to ensure accurate tracking of when it was last updated.

        Example:
            ```python
            session_order = SessionOrder(session_id=12345)
            session_order.set_updated_date_to_now()
            print(f"Updated at: {session_order.updated_date}")
            ```
        """
        self.updated_date = self.get_current_us_central_time()

    def merge(self, source: "SessionOrder") -> None:
        """Merge fields from source SessionOrder into this instance.

        This method follows good OOP principles by encapsulating the merge logic
        within the model itself, limiting ripple effects and making the code
        more maintainable.

        Args:
            source: Source SessionOrder to merge from

        Example:
            ```python
            existing_session = SessionOrder(session_id=12345, sale_id="SALE123")
            new_session = SessionOrder(session_id=12345, sale_id="SALE123", order_number="ORD456")

            # Merge new data into existing session
            existing_session.merge(new_session)
            print(f"Order number: {existing_session.order_number}")  # "ORD456"
            ```

        Notes:
            - Merges order items by SKU and location (updates existing, adds new)
            - Preserves existing enriched fields unless source has better data
            - Updates timing fields if source has more recent information
            - Updates user fields if source has more complete information
            - Updates session status and metadata if source has newer values
        """
        if not source:
            return

        # Merge order items - this is the most complex part
        for source_item in source.order_items:
            # Check if this order item already exists by SKU and location
            item_exists = False
            for i, existing_item in enumerate(self.order_items):
                if (
                    existing_item.sku == source_item.sku
                    and existing_item.location == source_item.location
                ):
                    # Update existing item
                    self.order_items[i] = source_item
                    item_exists = True
                    break

            if not item_exists:
                # Add new item to existing session
                self.order_items.append(source_item)

        # Merge metadata fields - preserve existing unless source has better data
        if source.order_number and not self.order_number:
            self.order_number = source.order_number
        elif source.order_number and self.order_number != source.order_number:
            self.order_number = source.order_number

        # Merge timing fields - update if source has more recent information
        if source.pick_start_datetime and (
            not self.pick_start_datetime
            or self.pick_start_datetime != source.pick_start_datetime
        ):
            self.pick_start_datetime = source.pick_start_datetime

        if source.pick_end_datetime and (
            not self.pick_end_datetime
            or self.pick_end_datetime != source.pick_end_datetime
        ):
            self.pick_end_datetime = source.pick_end_datetime

        # Merge user fields - update if source has more complete information
        if source.picked_by_user_id and (
            not self.picked_by_user_id
            or self.picked_by_user_id != source.picked_by_user_id
        ):
            self.picked_by_user_id = source.picked_by_user_id

        if source.picked_by_user_name and (
            not self.picked_by_user_name
            or self.picked_by_user_name != source.picked_by_user_name
        ):
            self.picked_by_user_name = source.picked_by_user_name

        # Merge session status - update if source has newer status
        if source.session_status and (
            not self.session_status or self.session_status != source.session_status
        ):
            logger.debug(
                LogContext(
                    step="session_merge",
                    action="session_status_update",
                    details={
                        "session_id": self.session_id,
                        "sale_id": self.sale_id,
                        "old_status_type": (
                            type(self.session_status).__name__
                            if self.session_status
                            else "None"
                        ),
                        "old_status_value": (
                            str(self.session_status) if self.session_status else "None"
                        ),
                        "new_status_type": type(source.session_status).__name__,
                        "new_status_value": str(source.session_status),
                        "status_will_change": True,
                    },
                )
            )
            # Keep the enum - JSONService will handle conversion to string
            self.session_status = source.session_status

            logger.debug(
                LogContext(
                    step="session_merge",
                    action="session_status_updated",
                    details={
                        "session_id": self.session_id,
                        "sale_id": self.sale_id,
                        "final_status_type": type(self.session_status).__name__,
                        "final_status_value": str(self.session_status),
                        "has_value_attribute": hasattr(self.session_status, "value"),
                        "value_attribute_type": (
                            type(getattr(self.session_status, "value", None)).__name__
                            if hasattr(self.session_status, "value")
                            else "N/A"
                        ),
                    },
                )
            )

        # Merge creation date - update if source has newer information
        if source.create_date and (
            not self.create_date or self.create_date != source.create_date
        ):
            self.create_date = source.create_date

        # Merge picklist ID - update if source has newer information
        if source.session_picklist_id and (
            not self.session_picklist_id
            or self.session_picklist_id != source.session_picklist_id
        ):
            self.session_picklist_id = source.session_picklist_id

        # Merge updated_date - always update to current time when merging
        # This ensures we track when the session order was last updated
        self.updated_date = self.get_current_us_central_time()

    def to_custom_field_2(self) -> str:
        """Generate custom field 2 value in format '[session_id]  #[spot_number]'.

        Returns:
            String in format '[session_id]  #[spot_number]' with 2 spaces
            between session_id and '#' followed by spot_number.

        Example:
            ```python
            order = SessionOrder(session_id=12345, spot_number=7)
            custom_field = order.to_custom_field_2()  # Returns "12345  #7"
            ```
        """
        if self.session_id is None or self.spot_number is None:
            return ""

        return f"{self.session_id}  #{self.spot_number}"


class ParsedSession(BaseModel):
    """Parsed and simplified session data for easy consumption.

    This model provides a clean interface for session data,
    converting raw API responses into structured, typed objects.
    """

    session_id: Optional[int] = None
    picklist_id: Optional[str] = None
    status: Optional[SessionState] = None
    created_date: Optional[str] = None
    assigned_user: Optional[str] = None
    user_id: Optional[str] = None
    sku_count: Optional[int] = None
    order_count: Optional[int] = None
    total_quantity: Optional[float] = None
    picked_quantity: Optional[float] = None
    available_quantity: Optional[float] = None
    total_weight: Optional[float] = None
    view_url: Optional[str] = None
    extracted_at: Optional[float] = None

    @field_validator("user_id", mode="before")
    @classmethod
    def convert_user_id_to_string(cls, v: Union[int, str, None]) -> Union[str, None]:
        """Convert user_id to string if it's an integer."""
        if isinstance(v, int):
            return str(v)
        return v
