/**
 * Utility functions for extracting fields from ShipStation webhook payloads
 * These functions normalize and extract data from shipmentData JSONB
 */

/**
 * Extract order_number from shipmentData
 * Returns the customer-facing order number (e.g., "JK3825345229")
 */
export function extractOrderNumber(shipmentData: any): string | null {
  return shipmentData?.shipment_number || shipmentData?.shipmentNumber || null;
}

/**
 * Extract order_date from shipmentData
 * Returns the ShipStation shipment creation timestamp (ISO 8601 format)
 * Looks for createDate (snake_case) or createdAt (camelCase) fields
 */
export function extractOrderDate(shipmentData: any): Date | null {
  const dateStr = shipmentData?.create_date || shipmentData?.createDate || shipmentData?.created_at || shipmentData?.createdAt;
  
  if (!dateStr) {
    return null;
  }
  
  try {
    const date = new Date(dateStr);
    // Validate that the date is valid
    if (isNaN(date.getTime())) {
      return null;
    }
    return date;
  } catch (e) {
    return null;
  }
}

/**
 * Extract ship_to customer fields from shipmentData
 * Returns an object with all ship_to fields
 */
export function extractShipToFields(shipmentData: any) {
  const shipTo = shipmentData?.ship_to || {};
  return {
    shipToName: shipTo.name || null,
    shipToPhone: shipTo.phone || null,
    shipToEmail: shipTo.email || null,
    shipToCompany: shipTo.company || null,
    shipToAddressLine1: shipTo.address_line1 || null,
    shipToAddressLine2: shipTo.address_line2 || null,
    shipToAddressLine3: shipTo.address_line3 || null,
    shipToCity: shipTo.city_locality || null,
    shipToState: shipTo.state_province || null,
    shipToPostalCode: shipTo.postal_code || null,
    shipToCountry: shipTo.country_code || null,
    shipToIsResidential: shipTo.address_residential_indicator || null,
  };
}

/**
 * Extract return and gift information from shipmentData
 */
export function extractReturnGiftFields(shipmentData: any) {
  return {
    isReturn: shipmentData?.is_return ?? null,
    isGift: shipmentData?.is_gift ?? null,
    notesForGift: shipmentData?.gift_message || null,
    notesFromBuyer: shipmentData?.customer_notes || null,
  };
}

/**
 * Extract total_weight from shipmentData
 * Concatenates value and unit into a single string (e.g., "2.5 pounds")
 */
export function extractTotalWeight(shipmentData: any): string | null {
  const totalWeight = shipmentData?.total_weight;
  if (!totalWeight || typeof totalWeight !== 'object') {
    return null;
  }
  
  const value = totalWeight.value;
  const unit = totalWeight.unit;
  
  if (value !== null && value !== undefined && unit) {
    return `${value} ${unit}`;
  }
  
  return null;
}

/**
 * Extract all advanced_options fields from shipmentData
 * Returns an object with all 26 advanced_options fields
 */
export function extractAdvancedOptions(shipmentData: any) {
  const advOpts = shipmentData?.advanced_options || {};
  
  return {
    billToAccount: advOpts.bill_to_account || null,
    billToCountryCode: advOpts.bill_to_country_code || null,
    billToParty: advOpts.bill_to_party || null,
    billToPostalCode: advOpts.bill_to_postal_code || null,
    billToName: advOpts.bill_to_name || null,
    billToAddressLine1: advOpts.bill_to_address_line1 || null,
    containsAlcohol: advOpts.contains_alcohol ?? null,
    deliveredDutyPaid: advOpts.delivered_duty_paid ?? null,
    nonMachinable: advOpts.non_machinable ?? null,
    saturdayDelivery: advOpts.saturday_delivery ?? null,
    dryIce: advOpts.dry_ice ?? null,
    dryIceWeight: advOpts.dry_ice_weight || null,
    fedexFreight: advOpts.fedex_freight || null,
    thirdPartyConsignee: advOpts.third_party_consignee ?? null,
    guaranteedDutiesAndTaxes: advOpts.guaranteed_duties_and_taxes ?? null,
    ancillaryEndorsementsOption: advOpts.ancillary_endorsements_option || null,
    freightClass: advOpts.freight_class || null,
    customField1: advOpts.custom_field1 || null,
    customField2: advOpts.custom_field2 || null,
    customField3: advOpts.custom_field3 || null,
    collectOnDelivery: advOpts.collect_on_delivery || null,
    returnPickupAttempts: advOpts.return_pickup_attempts || null,
    additionalHandling: advOpts.additional_handling ?? null,
    ownDocumentUpload: advOpts.own_document_upload ?? null,
    limitedQuantity: advOpts.limited_quantity ?? null,
    eventNotification: advOpts.event_notification ?? null,
    importServices: advOpts.import_services ?? null,
    overrideHoliday: advOpts.override_holiday ?? null,
  };
}
