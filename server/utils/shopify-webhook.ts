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

export async function deleteShopifyWebhook(
  shopDomain: string,
  accessToken: string,
  webhookId: string
): Promise<void> {
  const url = `https://${shopDomain}/admin/api/2024-01/webhooks/${webhookId}.json`;
  
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete webhook ${webhookId}: ${response.status} ${errorText}`);
  }
}

export async function deleteAllShopifyWebhooks(
  shopDomain: string,
  accessToken: string
): Promise<number> {
  const existingWebhooks = await listShopifyWebhooks(shopDomain, accessToken);
  
  let deletedCount = 0;
  for (const webhook of existingWebhooks) {
    try {
      console.log(`Deleting webhook: ${webhook.topic} (ID: ${webhook.id})`);
      await deleteShopifyWebhook(shopDomain, accessToken, webhook.id.toString());
      deletedCount++;
    } catch (error) {
      console.error(`Failed to delete webhook ${webhook.id}:`, error);
      // Continue deleting other webhooks even if one fails
    }
  }
  
  return deletedCount;
}

export async function reregisterAllWebhooks(
  shopDomain: string,
  accessToken: string,
  webhookBaseUrl: string
): Promise<{ deleted: number; registered: number }> {
  console.log('⚠️  WEBHOOK RE-REGISTRATION STARTED - Critical operation');
  console.log(`Shop: ${shopDomain}, Base URL: ${webhookBaseUrl}`);
  
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
    { topic: 'products/create', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
    { topic: 'products/update', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
    { topic: 'products/delete', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
  ];

  // Get list of existing webhooks before making any changes
  const existingWebhooks = await listShopifyWebhooks(shopDomain, accessToken);
  console.log(`Found ${existingWebhooks.length} existing webhook(s)`);
  
  // PER-TOPIC REPLACEMENT STRATEGY
  // For each webhook: (1) cache old, (2) delete old, (3) create new, (4) rollback if failed
  // This avoids Shopify's duplicate topic/address constraint
  let replacedCount = 0;
  let deletedCount = 0;
  const failures: string[] = [];
  
  for (const required of requiredWebhooks) {
    console.log(`\n→ Replacing webhook: ${required.topic}`);
    
    // Find existing webhook with this topic
    const existing = existingWebhooks.find((w: any) => w.topic === required.topic);
    
    if (!existing) {
      // No existing webhook for this topic - just create it
      try {
        console.log(`  No existing webhook found, creating new...`);
        await registerShopifyWebhook(shopDomain, accessToken, required.topic, required.address);
        replacedCount++;
        console.log(`  ✓ Created ${required.topic}`);
      } catch (error: any) {
        const errorMsg = `Failed to create ${required.topic}: ${error.message}`;
        console.error(`  ✗ ${errorMsg}`);
        failures.push(errorMsg);
      }
      continue;
    }
    
    // Cache existing webhook data for rollback
    const cachedWebhook = {
      id: existing.id.toString(),
      topic: existing.topic,
      address: existing.address,
      format: existing.format || 'json',
    };
    console.log(`  Found existing webhook (ID: ${cachedWebhook.id})`);
    
    try {
      // Step 1: Delete old webhook
      console.log(`  Step 1/2: Deleting old webhook...`);
      await deleteShopifyWebhook(shopDomain, accessToken, cachedWebhook.id);
      deletedCount++;
      console.log(`  ✓ Deleted old webhook`);
      
      // Step 2: Create new webhook (with updated secret)
      try {
        console.log(`  Step 2/2: Creating new webhook...`);
        await registerShopifyWebhook(shopDomain, accessToken, required.topic, required.address);
        replacedCount++;
        console.log(`  ✓ Created new webhook`);
      } catch (createError: any) {
        // ROLLBACK: Re-create the original webhook
        console.error(`  ✗ Failed to create new webhook: ${createError.message}`);
        console.log(`  🔄 ROLLBACK: Re-creating original webhook...`);
        
        try {
          // Try to restore the original (note: it will have a new ID)
          await registerShopifyWebhook(shopDomain, accessToken, cachedWebhook.topic, cachedWebhook.address);
          console.log(`  ✓ Rollback successful - original webhook restored`);
          failures.push(`Failed to replace ${required.topic} (rolled back): ${createError.message}`);
        } catch (rollbackError: any) {
          console.error(`  ✗ ROLLBACK FAILED: ${rollbackError.message}`);
          failures.push(`CRITICAL: Failed to replace AND rollback ${required.topic}. Webhook may be missing!`);
        }
      }
    } catch (deleteError: any) {
      // Failed to delete - original webhook still exists (safe)
      console.error(`  ✗ Failed to delete old webhook: ${deleteError.message}`);
      failures.push(`Failed to delete old ${required.topic}: ${deleteError.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ WEBHOOK RE-REGISTRATION COMPLETE');
  console.log(`Summary: Replaced ${replacedCount}/${requiredWebhooks.length} webhooks, deleted ${deletedCount} old`);
  
  if (failures.length > 0) {
    console.warn(`\n⚠️  Encountered ${failures.length} issue(s):`);
    failures.forEach((f, i) => console.warn(`  ${i + 1}. ${f}`));
    console.warn('\nCheck Shopify admin to verify webhook configuration.');
    
    // If ANY critical failures (rollback failed), throw error
    const criticalFailures = failures.filter(f => f.includes('CRITICAL'));
    if (criticalFailures.length > 0) {
      throw new Error(`Critical failures during webhook re-registration. ${criticalFailures.length} webhook(s) may be missing. Check logs and Shopify admin immediately.`);
    }
    
    // If ALL replacements failed, throw error
    if (replacedCount === 0) {
      throw new Error(`Failed to replace any webhooks. ${failures.join('; ')}`);
    }
  }
  
  return { deleted: deletedCount, registered: replacedCount };
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
    { topic: 'products/create', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
    { topic: 'products/update', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
    { topic: 'products/delete', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
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
  } catch (error: any) {
    console.error('Error ensuring webhooks are registered:', error);
    
    // Provide helpful guidance for common errors
    if (error.message?.includes('products/create') || error.message?.includes('products/update') || error.message?.includes('products/delete')) {
      console.error('\n⚠️  PRODUCT WEBHOOK REGISTRATION FAILED');
      console.error('─────────────────────────────────────────');
      console.error('Product webhooks require the "write_products" scope in your Shopify app.');
      console.error('\nTo fix this:');
      console.error('1. Go to your Shopify admin: Apps → [Your App] → Configuration');
      console.error('2. Add the "write_products" scope under Admin API access scopes');
      console.error('3. Click "Save" and reinstall the app to refresh the access token');
      console.error('4. Restart this application to re-register webhooks');
      console.error('\nUntil then, product data will sync via bootstrap on startup only.');
      console.error('─────────────────────────────────────────\n');
    }
    
    throw error;
  }
}
