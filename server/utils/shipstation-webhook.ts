import crypto from 'crypto';
import { Request } from 'express';

interface JWK {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

interface JWKS {
  keys: JWK[];
}

let cachedJWKS: JWKS | null = null;
let cacheTime: number = 0;
const CACHE_DURATION = 3600000; // 1 hour in milliseconds

/**
 * Fetch ShipStation's public keys from JWKS endpoint
 */
async function getJWKS(): Promise<JWKS> {
  const now = Date.now();
  
  if (cachedJWKS && (now - cacheTime < CACHE_DURATION)) {
    return cachedJWKS;
  }

  // ShipStation webhooks use ShipEngine infrastructure
  // Correct JWKS endpoint is /jwks not /.well-known/jwks.json
  const response = await fetch('https://api.shipengine.com/jwks');
  
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.statusText}`);
  }

  cachedJWKS = await response.json();
  cacheTime = now;
  
  return cachedJWKS!;
}

/**
 * Convert Base64URL to standard Base64
 */
function base64UrlToBase64(base64url: string): string {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if needed
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return base64;
}

/**
 * Convert JWK to PEM format for crypto verification
 */
function jwkToPem(jwk: JWK): string {
  const modulus = Buffer.from(base64UrlToBase64(jwk.n), 'base64');
  const exponent = Buffer.from(base64UrlToBase64(jwk.e), 'base64');

  // Build DER-encoded public key
  const modulusLength = modulus.length;
  const exponentLength = exponent.length;

  // Simplified PEM generation - in production, use a library like jwk-to-pem
  const derBuffer = Buffer.concat([
    Buffer.from([0x30]), // SEQUENCE
    Buffer.from([0x82]), // Length bytes to follow (2 bytes)
    Buffer.from([(modulusLength + exponentLength + 20) >> 8]),
    Buffer.from([(modulusLength + exponentLength + 20) & 0xff]),
    Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]), // RSA OID
    Buffer.from([0x03]), // BIT STRING
    Buffer.from([0x82]),
    Buffer.from([(modulusLength + exponentLength + 5) >> 8]),
    Buffer.from([(modulusLength + exponentLength + 5) & 0xff]),
    Buffer.from([0x00]), // No padding bits
    Buffer.from([0x30]), // SEQUENCE
    Buffer.from([0x82]),
    Buffer.from([(modulusLength + exponentLength + 2) >> 8]),
    Buffer.from([(modulusLength + exponentLength + 2) & 0xff]),
    Buffer.from([0x02]), // INTEGER (modulus)
    Buffer.from([0x82]),
    Buffer.from([modulusLength >> 8]),
    Buffer.from([modulusLength & 0xff]),
    modulus,
    Buffer.from([0x02]), // INTEGER (exponent)
    Buffer.from([exponentLength]),
    exponent,
  ]);

  const pem = `-----BEGIN PUBLIC KEY-----\n${derBuffer.toString('base64').match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
  return pem;
}

/**
 * Verify ShipStation webhook signature using RSA-SHA256
 */
export async function verifyShipStationWebhook(req: Request, rawBody: string): Promise<boolean> {
  const signature = req.headers['x-shipengine-rsa-sha256-signature'] as string;
  const keyId = req.headers['x-shipengine-rsa-sha256-key-id'] as string;
  const timestamp = req.headers['x-shipengine-timestamp'] as string;

  // Check if all required headers are present
  if (!signature || !keyId || !timestamp) {
    console.warn('Missing ShipStation webhook signature headers');
    return false;
  }

  // Verify timestamp to prevent replay attacks (allow 5 minute window)
  const webhookTime = new Date(timestamp).getTime();
  const currentTime = Date.now();
  const timeDiff = Math.abs(currentTime - webhookTime);
  
  if (timeDiff > 5 * 60 * 1000) {
    console.warn('ShipStation webhook timestamp too old or in future');
    return false;
  }

  try {
    // Fetch public keys
    const jwks = await getJWKS();
    const jwk = jwks.keys.find(key => key.kid === keyId);

    if (!jwk) {
      console.error('JWK not found for key ID:', keyId);
      return false;
    }

    // Convert JWK to PEM
    const publicKey = jwkToPem(jwk);

    // Construct signed payload: timestamp + "." + rawBody
    const signedPayload = `${timestamp}.${rawBody}`;

    // Verify signature (convert from Base64URL to Base64)
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(signedPayload);
    const signatureBase64 = base64UrlToBase64(signature);
    const isValid = verifier.verify(publicKey, signatureBase64, 'base64');

    return isValid;
  } catch (error) {
    console.error('Error verifying ShipStation webhook signature:', error);
    return false;
  }
}

/**
 * Normalize webhook base URL by removing trailing slashes
 */
export function normalizeWebhookUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface WebhookRegistrationResult {
  success: boolean;
  registeredEvents: string[];
  failedEvents: { event: string; error: string }[];
  existingEvents: string[];
  cleanedUpCount: number;
}

/**
 * Register ShipStation webhooks for ALL shipment events
 * This is critical for warehouse operations to see every shipment action
 */
export async function ensureShipStationWebhooksRegistered(webhookBaseUrl: string): Promise<WebhookRegistrationResult> {
  const apiKey = process.env.SHIPSTATION_API_KEY;

  if (!apiKey) {
    throw new Error('ShipStation API credentials not configured');
  }

  const baseUrl = normalizeWebhookUrl(webhookBaseUrl);
  const webhookUrl = `${baseUrl}/api/webhooks/shipstation/shipments`;
  
  // Determine environment for labeling webhooks
  const envLabel = process.env.REPLIT_DEPLOYMENT === '1' ? 'PROD' : 'DEV';

  // All shipment events warehouse needs to track
  // Note: ShipStation V2 API only supports these fulfillment events:
  // - fulfillment_shipped_v2: Triggers when items ship via fulfillment provider
  // - fulfillment_rejected_v2: Triggers when items are rejected by fulfillment provider
  // There are NO events for on_hold status changes - that requires polling
  const events = [
    'fulfillment_shipped_v2',    // Shipment shipped via fulfillment provider
    'fulfillment_rejected_v2',   // Fulfillment rejected by carrier/marketplace
    'track',                     // Tracking updates (most important for warehouse!)
    'batch',                     // Batch operations
  ];

  try {
    // Get existing webhooks
    const listResponse = await fetch('https://api.shipstation.com/v2/environment/webhooks', {
      method: 'GET',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!listResponse.ok) {
      throw new Error(`Failed to list ShipStation webhooks: ${listResponse.statusText}`);
    }

    const webhooks = await listResponse.json();
    
    // CLEANUP: Only delete orphaned webhooks for THIS environment
    // IMPORTANT: Never delete webhooks from other environments (e.g., don't delete [PROD] when running in DEV)
    // This prevents dev/prod from fighting over webhook registration when sharing the same API key
    const orphanedWebhooks = webhooks?.filter((webhook: any) => {
      // Check if webhook name contains an environment label
      const nameMatch = webhook.name?.match(/\[([A-Z]+)\]/);
      const webhookEnv = nameMatch ? nameMatch[1] : null;
      
      // Also check if URL matches our base URL
      try {
        const webhookUrlObj = new URL(webhook.url);
        const currentUrlObj = new URL(baseUrl);
        const urlMatches = webhookUrlObj.host === currentUrlObj.host;
        
        // CRITICAL: Never touch webhooks from other environments!
        // If webhook has a different env label (e.g., [PROD] when we're DEV), leave it alone
        if (webhookEnv && webhookEnv !== envLabel) {
          return false; // Not orphaned - belongs to another environment
        }
        
        // Only cleanup webhooks that:
        // 1. Have OUR environment label but point to a different URL (stale from old deployment)
        // 2. Have NO label and point to our URL (old webhook that needs to be replaced with labeled version)
        const hasOurLabel = webhookEnv === envLabel;
        const hasNoLabel = !webhookEnv;
        
        // Stale webhook from our environment pointing to wrong URL
        if (hasOurLabel && !urlMatches) {
          return true;
        }
        
        // Old unlabeled webhook pointing to our URL - replace with labeled version
        if (hasNoLabel && urlMatches) {
          return true;
        }
        
        return false;
      } catch (error: any) {
        console.warn(`Skipping webhook with malformed URL: ${webhook.url} (${error.message})`);
        return false;
      }
    }) || [];
    
    const result: WebhookRegistrationResult = {
      success: true,
      registeredEvents: [],
      failedEvents: [],
      existingEvents: [],
      cleanedUpCount: 0,
    };

    if (orphanedWebhooks.length > 0) {
      console.log(`🧹 Cleaning up ${orphanedWebhooks.length} orphaned ShipStation webhook(s) from other environments:`);
      for (const orphaned of orphanedWebhooks) {
        try {
          console.log(`   Deleting: ${orphaned.name} -> ${orphaned.url} (ID: ${orphaned.webhook_id})`);
          await deleteShipStationWebhook(apiKey, orphaned.webhook_id);
          console.log(`   ✓ Deleted orphaned webhook ${orphaned.webhook_id}`);
          result.cleanedUpCount++;
        } catch (error: any) {
          console.error(`   ✗ Failed to delete orphaned webhook ${orphaned.webhook_id}:`, error.message);
        }
      }
    }

    // Register each event type
    for (const event of events) {
      const webhookName = `[${envLabel}] Warehouse Fulfillment - ${event}`;
      
      const existingWebhook = webhooks?.find((w: any) => 
        w.url === webhookUrl && w.event === event && w.name === webhookName
      );

      if (existingWebhook) {
        console.log(`ShipStation ${event} webhook already registered`);
        result.existingEvents.push(event);
        continue;
      }

      // Register new webhook for this event with environment label
      const registerResponse = await fetch('https://api.shipstation.com/v2/environment/webhooks', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: webhookName,
          event: event,
          url: webhookUrl,
          store_id: null, // null means all stores
        }),
      });

      if (!registerResponse.ok) {
        const errorText = await registerResponse.text();
        const errorMsg = `${registerResponse.statusText} - ${errorText}`;
        console.error(`Failed to register ShipStation ${event} webhook: ${errorMsg}`);
        result.failedEvents.push({ event, error: errorMsg });
        result.success = false;
        continue; // Try to register other events even if one fails
      }

      console.log(`ShipStation ${event} webhook registered successfully`);
      result.registeredEvents.push(event);
    }

    return result;
  } catch (error) {
    console.error('Error managing ShipStation webhooks:', error);
    throw error;
  }
}

/**
 * List all ShipStation webhooks
 */
export async function listShipStationWebhooks(apiKey: string): Promise<any[]> {
  const response = await fetch('https://api.shipstation.com/v2/environment/webhooks', {
    method: 'GET',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list ShipStation webhooks: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Delete a ShipStation webhook by ID
 */
export async function deleteShipStationWebhook(apiKey: string, webhookId: string): Promise<void> {
  const response = await fetch(`https://api.shipstation.com/v2/environment/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete ShipStation webhook ${webhookId}: ${response.statusText} - ${errorText}`);
  }
}
