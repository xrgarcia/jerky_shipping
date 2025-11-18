"""SkuVault order models.

This module contains models for SkuVault order data structures.
All fields are optional to handle varying payload shapes from the API.
All models allow extra fields to preserve unknown data from the API.

Example:
    ```python
    order_data = {
        "Id": "1-352444-5-13038-138162-JK3825269577",
        "Status": "Completed",
        "SaleDate": "2024-12-06T00:02:51.0000000Z",
        ...
    }
    order = SkuvaultOrder(
        metadata=Metadata(
            source=SourceSystem.SKUVAULT,
            endpoint="/getSales"
        ),
        raw_payload=SkuvaultOrderPayload(**order_data)
    )
    ```
"""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from jerky_data_hub.models import BaseJerkyModel


class SkuvaultPrice(BaseModel):
    """Price structure with amount and currency symbol.

    Attributes:
        a: The numerical amount of the price
        s: The currency symbol (e.g., "$")

    Example:
        ```python
        price = SkuvaultPrice(a=52.99, s="$")
        ```
    """

    model_config = ConfigDict(extra='allow')  # Allow extra fields

    a: Optional[float] = Field(None, description="Amount")
    s: Optional[str] = Field(None, description="Currency symbol")


class SkuvaultSaleItem(BaseModel):
    """Sale item in an order.

    Attributes:
        Sku: Product SKU identifier
        Quantity: Number of items ordered
        UnitPrice: Price per unit
        Promotions: List of promotions applied
        Taxes: Tax amount for this item

    Example:
        ```python
        item = SkuvaultSaleItem(
            Sku="JCB-GB-WGJSSGB-RS",
            Quantity=1,
            UnitPrice=SkuvaultPrice(a=52.99, s="$"),
            Taxes=0.0
        )
        ```
    """

    model_config = ConfigDict(extra='allow')  # Allow extra fields

    Sku: str = Field(..., description="Product SKU identifier")
    Quantity: int = Field(..., description="Number of items ordered")
    UnitPrice: SkuvaultPrice = Field(..., description="Price per unit")
    Promotions: List[dict] = Field(default_factory=list, description="List of promotions applied")
    Taxes: float = Field(default=0.0, description="Tax amount for this item")

    @model_validator(mode='before')
    @classmethod
    def handle_null_promotions(cls, data: dict) -> dict:
        """Convert null Promotions to empty list."""
        if isinstance(data, dict) and data.get('Promotions') is None:
            data['Promotions'] = []
        return data


class SkuvaultShippingInfo(BaseModel):
    """Shipping address information.

    Attributes:
        City: Destination city
        Region: State/province/region
        Country: Country code
        PostalCode: ZIP/postal code
        Address1: Primary address line
        Address2: Secondary address line

    Example:
        ```python
        shipping = SkuvaultShippingInfo(
            City="RIENZI",
            Region="MS",
            Country="US",
            PostalCode="38865-9030",
            Address1="94 COUNTY ROAD 534"
        )
        ```
    """

    model_config = ConfigDict(extra='allow')  # Allow extra fields

    City: Optional[str] = None
    Region: Optional[str] = None
    Country: Optional[str] = None
    PostalCode: Optional[str] = None
    Address1: Optional[str] = None
    Address2: Optional[str] = None


class SkuvaultContactInfo(BaseModel):
    """Customer contact information.

    Attributes:
        FirstName: Customer's first name
        LastName: Customer's last name
        Company: Company name if applicable
        Phone: Contact phone number
        Email: Contact email address

    Example:
        ```python
        contact = SkuvaultContactInfo(
            FirstName="John",
            LastName="Doe",
            Phone="+16628084153",
            Email="john.doe@example.com"
        )
        ```
    """

    model_config = ConfigDict(extra='allow')  # Allow extra fields

    FirstName: Optional[str] = None
    LastName: Optional[str] = None
    Company: Optional[str] = None
    Phone: Optional[str] = None
    Email: Optional[str] = None


class SkuvaultOrderPayload(BaseModel):
    """Raw payload structure for SkuVault orders from /getSales endpoint.

    All fields are optional to handle varying payload shapes from the API.
    Timestamps may be in different formats (.NET, ISO, etc).
    Unknown fields are preserved in the model.

    Attributes:
        Id: Unique order identifier (REQUIRED)
        SellerSaleId: Seller's internal order ID
        MarketplaceId: External marketplace order ID
        ChannelId: Sales channel identifier
        Status: Order status (e.g., "Completed")
        SaleDate: When the order was placed
        Marketplace: Source marketplace name
        SaleItems: List of items in the order
        FulfilledItems: List of fulfilled items
        SaleKits: List of kits in the order
        FulfilledKits: List of fulfilled kits
        ShippingCost: Actual shipping cost
        ShippingCharge: Shipping amount charged
        ShippingCarrier: Carrier used
        ShippingClass: Shipping service level
        ShippingInfo: Delivery address details
        ContactInfo: Customer contact details
        Notes: Order notes
        PrintedStatus: Whether order was printed
        LastPrintedDate: When order was last printed
        Charges: Additional charges
        Promotions: Order-level promotions

    Example:
        ```python
        payload = SkuvaultOrderPayload(
            Id="1-352444-5-13038-138162-JK3825269577",
            SellerSaleId="804435473",
            MarketplaceId="JK3825269577",
            Status="Completed",
            SaleDate="2024-12-06T00:02:51.0000000Z",
            Marketplace="Shopify",
            SaleItems=[
                SkuvaultSaleItem(
                    Sku="BTJ-BEJ-1-16-X12",
                    Quantity=1,
                    UnitPrice=SkuvaultPrice(a=88.99, s="$"),
                    Taxes=0.0
                )
            ],
            ShippingInfo=SkuvaultShippingInfo(...),
            ContactInfo=SkuvaultContactInfo(...)
        )
        ```

    Notes:
        - Some fields are required and must be present in the payload
        - Optional fields are preserved if present
        - Preserves unknown fields from the API
        - Handles various timestamp formats
    """

    model_config = ConfigDict(extra='allow')  # Allow extra fields

    Id: str = Field(..., description="Unique order identifier")
    SellerSaleId: Optional[str] = Field(None, description="Seller's internal order ID")
    MarketplaceId: Optional[str] = Field(None, description="External marketplace order ID")
    ChannelId: Optional[str] = Field(None, description="Sales channel identifier")
    Status: str = Field(..., description="Order status")
    SaleDate: datetime = Field(..., description="When the order was placed")
    Marketplace: str = Field(..., description="Source marketplace name")
    SaleItems: List[SkuvaultSaleItem] = Field(default_factory=list, description="List of items in the order")
    FulfilledItems: List[SkuvaultSaleItem] = Field(default_factory=list, description="List of fulfilled items")
    SaleKits: List[dict] = Field(default_factory=list, description="List of kits in the order")
    FulfilledKits: List[dict] = Field(default_factory=list, description="List of fulfilled kits")
    ShippingCost: Optional[SkuvaultPrice] = None
    ShippingCharge: Optional[SkuvaultPrice] = None
    ShippingCarrier: Optional[str] = None
    ShippingClass: Optional[str] = None
    ShippingInfo: Optional[SkuvaultShippingInfo] = None
    ContactInfo: Optional[SkuvaultContactInfo] = None
    Notes: Optional[str] = None
    PrintedStatus: Optional[bool] = None
    LastPrintedDate: Optional[datetime] = None
    Charges: List[dict] = Field(default_factory=list, description="Additional charges")
    Promotions: List[dict] = Field(default_factory=list, description="Order-level promotions")


class SkuvaultOrder(BaseJerkyModel[SkuvaultOrderPayload]):
    """SkuVault order model.

    Represents a complete order from the SkuVault API, including
    all items, kits, shipping details, and processing status.
    All unknown fields from the API are preserved.

    Attributes:
        metadata: Common tracking fields for all records
        raw_payload: Complete order data from SkuVault API

    Example:
        ```python
        order = SkuvaultOrder(
            metadata=Metadata(
                source=SourceSystem.SKUVAULT,
                endpoint="/getSales"
            ),
            raw_payload=SkuvaultOrderPayload(
                Id="1-352444-5-13038-138162-JK3825269577",
                Status="Completed"
            )
        )
        ```

    Notes:
        - Inherits from BaseJerkyModel with SkuvaultOrderPayload type
        - Preserves all original data from SkuVault API
        - Includes standard metadata tracking
    """

    model_config = ConfigDict(extra='allow')  # Allow extra fields
