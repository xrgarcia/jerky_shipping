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

  const response = await fetch('https://api.shipstation.com/.well-known/jwks.json');
  
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

/**
 * Register ShipStation webhooks for shipment events
 */
export async function ensureShipStationWebhooksRegistered(webhookBaseUrl: string): Promise<void> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  const apiSecret = process.env.SHIPSTATION_API_KEY;

  if (!apiKey || !apiSecret) {
    throw new Error('ShipStation API credentials not configured');
  }

  const baseUrl = normalizeWebhookUrl(webhookBaseUrl);
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  const webhookUrl = `${baseUrl}/api/webhooks/shipstation/shipments`;

  try {
    // Get existing webhooks
    const listResponse = await fetch('https://ssapi.shipstation.com/webhooks', {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });

    if (!listResponse.ok) {
      throw new Error(`Failed to list ShipStation webhooks: ${listResponse.statusText}`);
    }

    const webhooks = await listResponse.json();
    const existingWebhook = webhooks.webhooks?.find((w: any) => 
      w.target_url === webhookUrl && w.event === 'SHIP_NOTIFY'
    );

    if (existingWebhook) {
      console.log('ShipStation SHIP_NOTIFY webhook already registered');
      return;
    }

    // Register new webhook for SHIP_NOTIFY event
    const registerResponse = await fetch('https://ssapi.shipstation.com/webhooks/subscribe', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target_url: webhookUrl,
        event: 'SHIP_NOTIFY',
        store_id: null, // null means all stores
        friendly_name: 'Warehouse Fulfillment - Shipments',
      }),
    });

    if (!registerResponse.ok) {
      const errorText = await registerResponse.text();
      throw new Error(`Failed to register ShipStation webhook: ${registerResponse.statusText} - ${errorText}`);
    }

    console.log('ShipStation SHIP_NOTIFY webhook registered successfully');
  } catch (error) {
    console.error('Error managing ShipStation webhooks:', error);
    throw error;
  }
}
