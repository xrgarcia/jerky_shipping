import crypto from 'crypto';

export function verifyShopifyWebhook(
  rawBody: Buffer | string,
  hmacHeader: string | undefined,
  secret: string
): boolean {
  if (!hmacHeader) {
    return false;
  }

  try {
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
    const hash = crypto
      .createHmac('sha256', secret)
      .update(body, 'utf-8')
      .digest('base64');

    const hashBuffer = Buffer.from(hash, 'base64');
    const hmacBuffer = Buffer.from(hmacHeader, 'base64');

    if (hashBuffer.length !== hmacBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(hashBuffer, hmacBuffer);
  } catch (error) {
    return false;
  }
}

export async function registerShopifyWebhook(
  shopDomain: string,
  accessToken: string,
  topic: string,
  address: string
): Promise<void> {
  const url = `https://${shopDomain}/admin/api/2024-01/webhooks.json`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      webhook: {
        topic,
        address,
        format: 'json',
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to register webhook for ${topic}: ${response.status} ${errorText}`);
  }
}

export async function listShopifyWebhooks(
  shopDomain: string,
  accessToken: string
): Promise<any[]> {
  const url = `https://${shopDomain}/admin/api/2024-01/webhooks.json`;
  
  const response = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list webhooks: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.webhooks || [];
}

export async function ensureWebhooksRegistered(
  shopDomain: string,
  accessToken: string,
  webhookBaseUrl: string
): Promise<void> {
  let normalizedBaseUrl = webhookBaseUrl.trim();
  
  if (!normalizedBaseUrl.startsWith('https://')) {
    throw new Error('WEBHOOK_BASE_URL must use HTTPS');
  }
  
  while (normalizedBaseUrl.endsWith('/')) {
    normalizedBaseUrl = normalizedBaseUrl.slice(0, -1);
  }

  const requiredWebhooks = [
    { topic: 'orders/create', address: `${normalizedBaseUrl}/api/webhooks/shopify/orders` },
    { topic: 'orders/updated', address: `${normalizedBaseUrl}/api/webhooks/shopify/orders` },
  ];

  try {
    const existingWebhooks = await listShopifyWebhooks(shopDomain, accessToken);
    
    for (const required of requiredWebhooks) {
      const exists = existingWebhooks.some(
        (webhook: any) => webhook.topic === required.topic && webhook.address === required.address
      );

      if (!exists) {
        console.log(`Registering webhook: ${required.topic} -> ${required.address}`);
        await registerShopifyWebhook(shopDomain, accessToken, required.topic, required.address);
        console.log(`Successfully registered webhook: ${required.topic}`);
      } else {
        console.log(`Webhook already registered: ${required.topic}`);
      }
    }
  } catch (error) {
    console.error('Error ensuring webhooks are registered:', error);
    throw error;
  }
}
