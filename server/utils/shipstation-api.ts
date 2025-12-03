/**
 * ShipStation API Client
 * Uses API-Key header authentication for V2 API
 */

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_BASE = 'https://api.shipstation.com';

// DRY RUN MODE: When true, label creation will log the request payload
// and skip the actual API call. Used for debugging label creation issues.
const DRY_RUN_PRINT_LABELS = false;

interface ShipStationShipment {
  shipmentId: number;
  orderId: number;
  orderKey: string;
  userId: string;
  orderNumber: string;
  trackingNumber: string;
  carrierCode: string;
  serviceCode: string;
  shipDate: string;
  createDate: string;
  shipmentCost: number;
  insuranceCost: number;
  voided: boolean;
  voidDate: string | null;
  marketplaceNotified: boolean;
  notifyErrorMessage: string | null;
}

interface ShipStationShipmentsResponse {
  shipments: ShipStationShipment[];
  total: number;
  page: number;
  pages: number;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

export interface ApiResponseWithRateLimit<T> {
  data: T;
  rateLimit: RateLimitInfo;
}

/**
 * Extract rate limit headers from ShipStation response
 */
function extractRateLimitInfo(headers: Headers): RateLimitInfo {
  return {
    limit: parseInt(headers.get('X-Rate-Limit-Limit') || '40'),
    remaining: parseInt(headers.get('X-Rate-Limit-Remaining') || '0'),
    reset: parseInt(headers.get('X-Rate-Limit-Reset') || '60'),
  };
}

/**
 * Safely extract PDF URL from ShipStation label_download object
 * 
 * ShipStation returns label_download as an object with multiple formats:
 * { pdf: "...url...", png: "...url...", zpl: "...url...", href: "...url..." }
 * 
 * CRITICAL: We MUST prefer PDF format for printing with SumatraPDF.
 * The `href` property can point to ZPL if that was the most recent format created,
 * which would cause printing failures with SumatraPDF (expects PDF input).
 * 
 * Detection strategy:
 * - Explicit ZPL indicators: .zpl extension OR format=zpl query param
 * - Everything else is assumed PDF-compatible (including ?format=PDF query params)
 * 
 * Priority order:
 * 1. label_download.pdf - Explicit PDF URL (always PDF)
 * 2. label_download.href - Accept unless it's explicitly ZPL
 * 3. null - If no valid URL found
 * 
 * @param labelDownload - The label_download object from ShipStation API
 * @returns PDF URL string or null if no PDF available
 */
export function extractPdfLabelUrl(labelDownload: any): string | null {
  if (!labelDownload) {
    return null;
  }
  
  /**
   * Check if a URL is explicitly ZPL format
   * ZPL indicators: .zpl extension OR format=zpl query param
   */
  function isZplUrl(url: string): boolean {
    const urlLower = url.toLowerCase();
    // Check file extension
    if (urlLower.includes('.zpl')) {
      return true;
    }
    // Check query parameter (format=zpl)
    try {
      const urlObj = new URL(url);
      const formatParam = urlObj.searchParams.get('format');
      if (formatParam && formatParam.toLowerCase() === 'zpl') {
        return true;
      }
    } catch {
      // If URL parsing fails, fall through to extension check only
    }
    return false;
  }
  
  // If label_download is a string, check if it's a valid non-ZPL URL
  if (typeof labelDownload === 'string') {
    if (isZplUrl(labelDownload)) {
      console.warn(`[ShipStation] label_download is ZPL format, skipping: ...${labelDownload.slice(-50)}`);
      return null;
    }
    return labelDownload;
  }
  
  // Priority 1: Explicit PDF URL (most reliable)
  if (labelDownload.pdf && typeof labelDownload.pdf === 'string') {
    return labelDownload.pdf;
  }
  
  // Priority 2: href URL - accept unless explicitly ZPL
  if (labelDownload.href && typeof labelDownload.href === 'string') {
    if (isZplUrl(labelDownload.href)) {
      console.warn(`[ShipStation] label_download.href is ZPL format, skipping: ...${labelDownload.href.slice(-50)}`);
      return null;
    }
    return labelDownload.href;
  }
  
  // Never fall back to ZPL or the whole object
  return null;
}

/**
 * Fetch shipments from ShipStation API using resource_url
 */
export async function fetchShipStationResource(resourceUrl: string): Promise<any> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  // ShipStation V2 API uses api-key header (lowercase)
  const response = await fetch(resourceUrl, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get labels for a shipment to retrieve tracking numbers
 */
export async function getLabelsForShipment(shipmentId: string): Promise<any[]> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const url = `${SHIPSTATION_API_BASE}/v2/labels?shipment_id=${encodeURIComponent(shipmentId)}`;
  
  const response = await fetch(url, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.labels || [];
}

/**
 * Get label data by label_id to retrieve shipment_id
 * Used to link orphaned tracking updates to shipments
 */
export async function getLabelByLabelId(labelId: string): Promise<any> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  // ShipStation V2 API: Use direct label lookup instead of list endpoint
  // The list endpoint at /v2/labels with label_id filter doesn't reliably filter
  // Instead, get the label directly from /v2/labels/{label_id}
  const url = `${SHIPSTATION_API_BASE}/v2/labels/${encodeURIComponent(labelId)}`;
  
  const response = await fetch(url, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`No label found for label_id: ${labelId}`);
    }
    throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
  }

  // Direct label lookup returns a single label object
  const label = await response.json();
  
  if (!label || !label.label_id) {
    throw new Error(`Invalid label response for label_id: ${labelId}`);
  }
  
  console.log(`[ShipStation API] Label lookup for ${labelId}: shipment_id=${label.shipment_id}`);
  
  return label;
}

/**
 * Create a label for an EXISTING shipment in ShipStation
 * 
 * Uses: POST /v2/labels/shipment/{shipment_id}
 * 
 * This is the correct endpoint for shipments that already exist in ShipStation.
 * It attaches a label to the existing shipment without creating duplicates.
 * 
 * The shipment_id goes in the URL path (not the request body).
 * The body only contains label formatting options.
 * 
 * @param shipmentId - The ShipStation shipment ID (e.g., "se-928749725")
 * @param options - Optional label format options
 * @returns Label data including PDF download URLs
 */
export async function createLabelForExistingShipment(
  shipmentId: string,
  options: {
    label_format?: 'pdf' | 'png' | 'zpl';
    label_layout?: '4x6' | 'letter';
    label_download_type?: 'url' | 'inline';
    validate_address?: 'no_validation' | 'validate_only' | 'validate_and_clean';
    test_label?: boolean;
  } = {}
): Promise<any> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  if (!shipmentId) {
    throw new Error('shipmentId is required to create a label for an existing shipment');
  }

  const url = `${SHIPSTATION_API_BASE}/v2/labels/shipment/${encodeURIComponent(shipmentId)}`;
  
  // Default label options - 4x6 PDF is standard for shipping labels
  const requestPayload = {
    label_format: options.label_format || 'pdf',
    label_layout: options.label_layout || '4x6',
    label_download_type: options.label_download_type || 'url',
    ...(options.validate_address && { validate_address: options.validate_address }),
    ...(options.test_label !== undefined && { test_label: options.test_label }),
  };
  
  // DRY RUN MODE: Log the request but DO NOT return a fake label
  if (DRY_RUN_PRINT_LABELS) {
    console.log('='.repeat(80));
    console.log('[ShipStation DRY RUN] Label creation for EXISTING shipment (API call SKIPPED)');
    console.log('='.repeat(80));
    console.log('[ShipStation DRY RUN] URL:', url);
    console.log('[ShipStation DRY RUN] Method: POST');
    console.log('[ShipStation DRY RUN] shipment_id (in URL):', shipmentId);
    console.log('[ShipStation DRY RUN] Request payload:');
    console.log(JSON.stringify(requestPayload, null, 2));
    console.log('='.repeat(80));
    console.log('[ShipStation DRY RUN] Returning null - NO fake label URL will be created');
    console.log('='.repeat(80));
    return null;
  }
  
  console.log(`[ShipStation] Creating label for existing shipment: ${shipmentId}`);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestPayload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ShipStation label creation failed: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  console.log(`[ShipStation] Label created successfully for shipment ${shipmentId}`);
  return result;
}

/**
 * Create a NEW shipment with label in one request
 * 
 * Uses: POST /v2/labels
 * 
 * WARNING: This endpoint creates a NEW shipment. Use createLabelForExistingShipment()
 * if the shipment already exists in ShipStation to avoid duplicates.
 * 
 * This function is for cases where we need to create both the shipment and label
 * together (e.g., direct-to-ShipStation orders not synced yet).
 * 
 * Note: shipment_id MUST be null/empty in the payload - ShipStation rejects
 * requests with shipment_id because this endpoint creates new shipments.
 */
export async function createNewShipmentWithLabel(shipmentData: any): Promise<any> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  // Remove shipment_id if present - this endpoint creates NEW shipments
  const cleanShipmentData = { ...shipmentData };
  if (cleanShipmentData.shipment_id) {
    console.warn('[ShipStation] Removing shipment_id from payload - use createLabelForExistingShipment() for existing shipments');
    delete cleanShipmentData.shipment_id;
  }

  const url = `${SHIPSTATION_API_BASE}/v2/labels`;
  const requestPayload = { shipment: cleanShipmentData };
  
  // DRY RUN MODE
  if (DRY_RUN_PRINT_LABELS) {
    console.log('='.repeat(80));
    console.log('[ShipStation DRY RUN] NEW shipment + label creation (API call SKIPPED)');
    console.log('='.repeat(80));
    console.log('[ShipStation DRY RUN] URL:', url);
    console.log('[ShipStation DRY RUN] Method: POST');
    console.log('[ShipStation DRY RUN] Full request payload:');
    console.log(JSON.stringify(requestPayload, null, 2));
    console.log('='.repeat(80));
    console.log('[ShipStation DRY RUN] Returning null - NO fake label URL will be created');
    console.log('='.repeat(80));
    return null;
  }
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestPayload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ShipStation label creation failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

/**
 * @deprecated Use createLabelForExistingShipment() for existing shipments
 * or createNewShipmentWithLabel() for new shipments.
 * 
 * This function had incorrect logic - it tried to use POST /v2/labels with
 * shipment_id in the body, but that endpoint rejects shipment_id because
 * it's designed for creating NEW shipments only.
 */
export async function createLabel(shipmentData: any): Promise<any> {
  // If shipment_id exists, use the correct endpoint for existing shipments
  if (shipmentData.shipment_id) {
    console.log('[ShipStation] Redirecting to createLabelForExistingShipment()');
    return createLabelForExistingShipment(shipmentData.shipment_id);
  }
  
  // Otherwise, create a new shipment with label
  return createNewShipmentWithLabel(shipmentData);
}

/**
 * Get shipments by order number with tracking numbers from labels
 * In ShipStation, shipment_number equals order_number
 * Returns shipments array and rate limit info
 * Fetches labels for each shipment to get tracking numbers
 */
export async function getShipmentsByOrderNumber(orderNumber: string): Promise<ApiResponseWithRateLimit<ShipStationShipment[]>> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  // V2 API endpoint - use shipment_number parameter (which equals order_number)
  const url = `${SHIPSTATION_API_BASE}/v2/shipments?shipment_number=${encodeURIComponent(orderNumber)}&sort_dir=desc&sort_by=created_at`;
  
  const response = await fetch(url, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();
  const shipments = data.shipments || [];
  const rateLimit = extractRateLimitInfo(response.headers);

  // Fetch labels for each shipment to get tracking numbers
  // Labels contain tracking_number which is not on the shipment object itself
  for (const shipment of shipments) {
    const shipmentId = shipment.shipment_id;
    if (shipmentId) {
      // Retry loop for rate limit handling
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount <= maxRetries) {
        try {
          const labelUrl = `${SHIPSTATION_API_BASE}/v2/labels?shipment_id=${encodeURIComponent(shipmentId)}`;
          const labelResponse = await fetch(labelUrl, {
            headers: {
              'api-key': SHIPSTATION_API_KEY,
              'Content-Type': 'application/json',
            },
          });
          
          // Handle 429 rate limit responses with retry
          if (labelResponse.status === 429) {
            const retryAfter = parseInt(labelResponse.headers.get('Retry-After') || '60');
            console.log(`[ShipStation] Rate limited (429) for shipment ${shipmentId}, waiting ${retryAfter}s before retry ${retryCount + 1}/${maxRetries}...`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + 1000));
            retryCount++;
            continue; // Retry
          }
          
          if (labelResponse.ok) {
            const labelData = await labelResponse.json();
            const labels = labelData.labels || [];
            if (labels.length > 0) {
              // Attach the first label's tracking number to the shipment
              // Also attach the full labels array for additional data
              shipment.tracking_number = labels[0].tracking_number || null;
              shipment.labels = labels;
            }
          }
          
          break; // Success, exit retry loop
        } catch (labelError: any) {
          // Log but don't fail - some shipments may not have labels yet (on_hold status)
          console.log(`[ShipStation] Could not fetch labels for shipment ${shipmentId}: ${labelError.message}`);
          break; // Don't retry on exceptions
        }
      }
    }
  }

  return {
    data: shipments,
    rateLimit,
  };
}

/**
 * Get shipment by shipment ID using V2 API
 * Returns shipment data and rate limit info, or null if not found
 */
export async function getShipmentByShipmentId(shipmentId: string): Promise<ApiResponseWithRateLimit<any | null>> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  // V2 API endpoint - use shipment_id parameter
  const url = `${SHIPSTATION_API_BASE}/v2/shipments?shipment_id=${encodeURIComponent(shipmentId)}&sort_dir=desc&sort_by=created_at`;
  
  const response = await fetch(url, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  const rateLimit = extractRateLimitInfo(response.headers);

  if (!response.ok) {
    if (response.status === 404) {
      return { data: null, rateLimit };
    }
    throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();
  const shipments = data.shipments || [];
  
  // Return the first matching shipment (there should only be one per shipment_id)
  const shipment = shipments.length > 0 ? shipments[0] : null;
  return { data: shipment, rateLimit };
}

/**
 * Helper to fetch labels for a batch of shipments with rate limit handling
 * Modifies shipments in place by attaching tracking_number and labels
 */
async function fetchLabelsForShipmentBatch(
  shipments: any[],
  rateLimit: RateLimitInfo,
  onProgress?: (processed: number, withTracking: number, total: number) => void
): Promise<{ rateLimit: RateLimitInfo; withTracking: number }> {
  let lastRateLimit = rateLimit;
  let labelsWithTracking = 0;
  
  // API key must be set (caller should have already checked)
  const apiKey = SHIPSTATION_API_KEY!;
  
  for (let i = 0; i < shipments.length; i++) {
    const shipment = shipments[i];
    const shipmentId = shipment.shipment_id;
    
    if (!shipmentId) continue;
    
    // Check rate limit before each label fetch
    if (lastRateLimit.remaining < 2) {
      const resetEpochMs = lastRateLimit.reset * 1000;
      const now = Date.now();
      
      if (resetEpochMs > now) {
        const waitTimeMs = resetEpochMs - now + 1000;
        const waitTimeSec = Math.ceil(waitTimeMs / 1000);
        console.log(`Rate limit exhausted during label fetch, waiting ${waitTimeSec}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTimeMs));
      }
    }
    
    // Retry loop for rate limit handling
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount <= maxRetries) {
      try {
        const labelUrl = `${SHIPSTATION_API_BASE}/v2/labels?shipment_id=${encodeURIComponent(shipmentId)}`;
        const labelResponse = await fetch(labelUrl, {
          headers: {
            'api-key': apiKey,
            'Content-Type': 'application/json',
          },
        });
        
        lastRateLimit = extractRateLimitInfo(labelResponse.headers);
        
        // Handle 429 rate limit responses with retry
        if (labelResponse.status === 429) {
          const retryAfter = parseInt(labelResponse.headers.get('Retry-After') || '60');
          console.log(`Rate limited by API (429) for shipment ${shipmentId}, waiting ${retryAfter}s before retry ${retryCount + 1}/${maxRetries}...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + 1000));
          retryCount++;
          continue;
        }
        
        if (labelResponse.ok) {
          const labelData = await labelResponse.json();
          const labels = labelData.labels || [];
          if (labels.length > 0) {
            shipment.tracking_number = labels[0].tracking_number || null;
            shipment.labels = labels;
            if (shipment.tracking_number) {
              labelsWithTracking++;
            }
          }
        }
        
        break; // Success
      } catch (labelError: any) {
        console.log(`Could not fetch labels for shipment ${shipmentId}: ${labelError.message}`);
        break; // Don't retry on exceptions
      }
    }
    
    // Progress callback every 50 items
    if (onProgress && (i + 1) % 50 === 0) {
      onProgress(i + 1, labelsWithTracking, shipments.length);
    }
  }
  
  return { rateLimit: lastRateLimit, withTracking: labelsWithTracking };
}

/**
 * Page result from getShipmentsByDateRange streaming
 */
export interface ShipmentPageResult {
  shipments: any[];
  page: number;
  totalPages: number;
  totalShipments: number;
  shipmentsWithTracking: number;
  rateLimit: RateLimitInfo;
}

/**
 * Get shipments by date range using V2 API with page-by-page processing
 * Processes each page immediately (fetch page -> fetch labels -> callback) instead of accumulating all data
 * This is more memory efficient and allows incremental progress
 * 
 * @param startDate Start of date range
 * @param endDate End of date range
 * @param pageSize Page size (max 500) - default 500
 * @param onPageComplete Optional callback called after each page is fully processed with labels
 */
export async function getShipmentsByDateRange(
  startDate: Date,
  endDate: Date,
  pageSize: number = 500,
  onPageComplete?: (result: ShipmentPageResult) => Promise<void>
): Promise<ApiResponseWithRateLimit<any[]>> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const allShipments: any[] = [];
  let page = 1;
  let lastRateLimit: RateLimitInfo = { limit: 40, remaining: 40, reset: 60 };
  let expectedTotal: number | null = null;
  let totalPages: number | null = null;
  let totalWithTracking = 0;

  const startDateISO = startDate.toISOString();
  const endDateISO = endDate.toISOString();

  console.log(`Fetching shipments from ${startDateISO} to ${endDateISO} (page-by-page processing)`);

  while (true) {
    // Check if we need to wait for rate limit reset
    if (lastRateLimit.remaining < 2) {
      const resetEpochMs = lastRateLimit.reset * 1000;
      const now = Date.now();
      
      if (resetEpochMs > now) {
        const waitTimeMs = resetEpochMs - now + 1000;
        const waitTimeSec = Math.ceil(waitTimeMs / 1000);
        console.log(`Rate limit exhausted (${lastRateLimit.remaining} remaining), waiting ${waitTimeSec}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTimeMs));
      }
    }

    const url = `${SHIPSTATION_API_BASE}/v2/shipments?created_at_start=${encodeURIComponent(startDateISO)}&created_at_end=${encodeURIComponent(endDateISO)}&page=${page}&page_size=${pageSize}&sort_by=created_at&sort_dir=desc`;
    
    const response = await fetch(url, {
      headers: {
        'api-key': SHIPSTATION_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    lastRateLimit = extractRateLimitInfo(response.headers);

    // Handle rate limit errors
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
      console.log(`Rate limited by API (429), waiting ${retryAfter}s before retry...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + 1000));
      continue; // Retry same page
    }

    if (!response.ok) {
      throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    const shipments = data.shipments || [];
    
    // Store expected total on first page
    if (expectedTotal === null && data.total) {
      expectedTotal = data.total;
      totalPages = data.pages || Math.ceil(data.total / pageSize);
      console.log(`Total shipments to fetch: ${expectedTotal} across ${totalPages} pages`);
    }
    
    console.log(`Page ${page}/${totalPages || '?'}: Fetched ${shipments.length} shipments, now fetching labels...`);
    
    // Immediately fetch labels for this page's shipments
    const labelResult = await fetchLabelsForShipmentBatch(
      shipments,
      lastRateLimit,
      (processed, withTracking, total) => {
        console.log(`  Page ${page} labels: ${processed}/${total} (${withTracking} with tracking)`);
      }
    );
    
    lastRateLimit = labelResult.rateLimit;
    totalWithTracking += labelResult.withTracking;
    
    console.log(`Page ${page} complete: ${shipments.length} shipments, ${labelResult.withTracking} with tracking numbers`);
    
    // Call the page complete callback so caller can process/save immediately
    if (onPageComplete) {
      await onPageComplete({
        shipments,
        page,
        totalPages: totalPages || page,
        totalShipments: expectedTotal || allShipments.length + shipments.length,
        shipmentsWithTracking: labelResult.withTracking,
        rateLimit: lastRateLimit,
      });
    }
    
    // Accumulate for backward compatibility (callers that don't use callback)
    allShipments.push(...shipments);

    // Check if we've fetched all pages
    const hasMoreData = data.total && allShipments.length < data.total;
    const hasMorePages = data.pages && page < data.pages;
    
    if (!hasMoreData && !hasMorePages) {
      console.log(`All pages complete: ${allShipments.length} shipments, ${totalWithTracking} with tracking numbers`);
      break;
    }
    
    page++;
  }

  return {
    data: allShipments,
    rateLimit: lastRateLimit,
  };
}

/**
 * Get fulfillment by tracking number using V2 API
 * Returns null if fulfillment not found
 */
export async function getFulfillmentByTrackingNumber(trackingNumber: string): Promise<any | null> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  // V2 API endpoint - supports tracking_number parameter
  const url = `${SHIPSTATION_API_BASE}/v2/fulfillments?tracking_number=${encodeURIComponent(trackingNumber)}`;
  
  const response = await fetch(url, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();
  const fulfillments = data.fulfillments || [];
  
  // Return the first matching fulfillment (there should only be one per tracking number)
  return fulfillments.length > 0 ? fulfillments[0] : null;
}

// ShipStation V2 webhook event types
export type ShipStationWebhookEvent = 
  | 'batch'
  | 'carrier_connected'
  | 'order_source_refresh_complete'
  | 'rate'
  | 'report_complete'
  | 'sales_orders_imported'
  | 'track'
  | 'batch_processed_v2'
  | 'fulfillment_rejected_v2'
  | 'fulfillment_shipped_v2'
  | 'fulfillment_created_v2'
  | 'fulfillment_canceled_v2'
  | 'fulfillment_updated_v2';

/**
 * Subscribe to ShipStation webhook (V2 API)
 */
export async function subscribeToWebhook(
  targetUrl: string,
  event: ShipStationWebhookEvent,
  friendlyName: string
): Promise<any> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const response = await fetch(`${SHIPSTATION_API_BASE}/v2/environment/webhooks`, {
    method: 'POST',
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: friendlyName,
      event,
      url: targetUrl,
      store_id: null, // null = all stores
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to subscribe to ShipStation webhook: ${response.status} ${errorText}`);
  }

  return response.json();
}

/**
 * List all registered webhooks
 */
export async function listWebhooks(): Promise<any[]> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const response = await fetch(`${SHIPSTATION_API_BASE}/v2/environment/webhooks`, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list ShipStation webhooks: ${response.status}`);
  }

  // V2 API returns array directly, not wrapped in {webhooks: [...]}
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Get tracking details for a shipment by tracking number
 * Returns rich tracking data including carrier status descriptions and event timeline
 */
export async function getTrackingDetails(trackingNumber: string): Promise<{
  labelId: string | null;
  trackingStatus: string | null;
  carrierStatusDescription: string | null;
  events: any[];
  rateLimit: RateLimitInfo;
} | null> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  try {
    // Step 1: Get label by tracking number
    const labelsUrl = `${SHIPSTATION_API_BASE}/v2/labels?tracking_number=${encodeURIComponent(trackingNumber)}`;
    const labelsResponse = await fetch(labelsUrl, {
      headers: {
        'api-key': SHIPSTATION_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    const rateLimit = extractRateLimitInfo(labelsResponse.headers);

    if (!labelsResponse.ok) {
      if (labelsResponse.status === 404) {
        return null;
      }
      throw new Error(`ShipStation API error: ${labelsResponse.status} ${labelsResponse.statusText}`);
    }

    const labelsData: any = await labelsResponse.json();
    const labels = labelsData.labels || [];
    
    if (labels.length === 0) {
      return null;
    }

    const label = labels[0];
    const labelId = label.label_id;
    
    // Step 2: Get detailed tracking events
    const trackingUrl = `${SHIPSTATION_API_BASE}/v2/labels/${labelId}/track`;
    const trackingResponse = await fetch(trackingUrl, {
      headers: {
        'api-key': SHIPSTATION_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (!trackingResponse.ok) {
      // If tracking details fail, return basic info from label
      return {
        labelId,
        trackingStatus: label.tracking_status || null,
        carrierStatusDescription: null,
        events: [],
        rateLimit,
      };
    }

    const trackingData: any = await trackingResponse.json();
    
    return {
      labelId,
      trackingStatus: trackingData.status_description || label.tracking_status || null,
      carrierStatusDescription: trackingData.carrier_status_description || null,
      events: trackingData.events || [],
      rateLimit,
    };
  } catch (error: any) {
    console.error(`Error fetching tracking details for ${trackingNumber}:`, error);
    return null;
  }
}

/**
 * Unsubscribe from a webhook
 */
export async function unsubscribeWebhook(webhookId: string): Promise<void> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const response = await fetch(`${SHIPSTATION_API_BASE}/v2/environment/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers: {
      'api-key': SHIPSTATION_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to unsubscribe ShipStation webhook: ${response.status}`);
  }
}

/**
 * Update shipment_number for an existing shipment in ShipStation
 * Uses PUT /v2/shipments/{shipment_id} to update the shipment
 * Fetches current shipment data, updates only shipment_number, and sends everything back
 * @param shipmentId The ShipStation shipment ID (e.g., "se-924665462")
 * @param newShipmentNumber The new shipment_number value (e.g., "JK3825346033-924665462")
 */
export async function updateShipmentNumber(shipmentId: string, newShipmentNumber: string): Promise<{ success: boolean; error?: string }> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  // First, get the current shipment data using direct path (not query param)
  const getUrl = `${SHIPSTATION_API_BASE}/v2/shipments/${encodeURIComponent(shipmentId)}`;
  
  console.log(`[ShipStation] Fetching current shipment data for ${shipmentId} via GET ${getUrl}`);
  
  const getResponse = await fetch(getUrl, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!getResponse.ok) {
    const errorText = await getResponse.text();
    return { success: false, error: `Failed to fetch shipment: ${getResponse.status} ${errorText}` };
  }

  const currentShipment = await getResponse.json();
  
  if (!currentShipment || !currentShipment.shipment_id) {
    return { success: false, error: `Shipment ${shipmentId} not found in ShipStation` };
  }
  
  console.log(`[ShipStation] Got shipment with external_shipment_id: ${currentShipment.external_shipment_id}, ship_from: ${currentShipment.ship_from ? 'present' : 'null'}`);
  
  // Update only the shipment_number field
  const updatePayload = {
    ...currentShipment,
    shipment_number: newShipmentNumber,
  };
  
  // Remove read-only fields that the API won't accept
  delete updatePayload.shipment_id;
  delete updatePayload.created_at;
  delete updatePayload.modified_at;
  delete updatePayload.label_id;
  delete updatePayload.shipment_status;
  delete updatePayload.label_status;
  delete updatePayload.tracking_number;
  delete updatePayload.label_download;
  delete updatePayload.form_download;
  delete updatePayload.insurance_claim;
  
  // API requires ship_from OR warehouse_id - handle null values
  // If both are null, provide a default ship_from address (Jerky.com warehouse)
  if (updatePayload.ship_from === null && updatePayload.warehouse_id === null) {
    console.log(`[ShipStation] Both ship_from and warehouse_id are null, using default ship_from`);
    updatePayload.ship_from = {
      name: "Jerky.com",
      phone: "",
      company_name: "Jerky.com",
      address_line1: "3600 NW 10th St",
      city_locality: "Oklahoma City",
      state_province: "OK",
      postal_code: "73107",
      country_code: "US",
    };
    delete updatePayload.warehouse_id;
  } else {
    // Remove null values - API rejects them
    if (updatePayload.ship_from === null) {
      delete updatePayload.ship_from;
    }
    if (updatePayload.warehouse_id === null) {
      delete updatePayload.warehouse_id;
    }
  }

  console.log(`[ShipStation] PUT updating shipment ${shipmentId} with new shipment_number: ${newShipmentNumber}`);
  console.log(`[ShipStation] Update payload keys:`, Object.keys(updatePayload).join(', '));

  const updateUrl = `${SHIPSTATION_API_BASE}/v2/shipments/${encodeURIComponent(shipmentId)}`;
  const updateResponse = await fetch(updateUrl, {
    method: 'PUT',
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updatePayload),
  });

  if (!updateResponse.ok) {
    const errorText = await updateResponse.text();
    console.error(`[ShipStation] Failed to PUT shipment ${shipmentId}:`, updateResponse.status, errorText);
    console.error(`[ShipStation] Full payload was:`, JSON.stringify(updatePayload, null, 2));
    return { success: false, error: `Failed to update shipment: ${updateResponse.status} ${errorText}` };
  }

  const result = await updateResponse.json();
  console.log(`[ShipStation] Successfully updated shipment ${shipmentId} shipment_number to: ${newShipmentNumber}`);
  
  return { success: true };
}
