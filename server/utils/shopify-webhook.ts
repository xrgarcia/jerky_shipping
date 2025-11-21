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
  const webhooks = data.webhooks || [];
  
  // Return webhooks with explicit field mapping to ensure consistent snake_case structure
  // (Shopify API returns snake_case; we maintain this for frontend compatibility)
  return webhooks.map((webhook: any) => ({
    id: webhook.id,
    address: webhook.address,
    topic: webhook.topic,
    created_at: webhook.created_at,
    updated_at: webhook.updated_at,
    format: webhook.format,
    fields: webhook.fields,
    metafield_namespaces: webhook.metafield_namespaces,
    private_metafield_namespaces: webhook.private_metafield_namespaces,
    api_version: webhook.api_version,
  }));
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
    { topic: 'refunds/create', address: `${normalizedBaseUrl}/api/webhooks/shopify/refunds` },
    { topic: 'products/create', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
    { topic: 'products/update', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
    { topic: 'products/delete', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
  ];

  // Get list of existing webhooks before making any changes
  const existingWebhooks = await listShopifyWebhooks(shopDomain, accessToken);
  console.log(`Found ${existingWebhooks.length} existing webhook(s)`);
  
  // CLEANUP: Delete orphaned webhooks that point to different base URLs
  // This ensures each environment only manages its own webhooks
  const requiredTopics = new Set(requiredWebhooks.map(w => w.topic));
  const orphanedWebhooks = existingWebhooks.filter((webhook: any) => {
    // Check if this webhook is for one of our topics
    if (!requiredTopics.has(webhook.topic)) {
      return false; // Not our topic, leave it alone (could be third-party integration)
    }
    
    // Check if this webhook points to a different base URL
    try {
      const webhookUrl = new URL(webhook.address);
      const currentUrl = new URL(normalizedBaseUrl);
      return webhookUrl.host !== currentUrl.host;
    } catch (error: any) {
      // Malformed webhook address - log and skip (don't delete malformed webhooks automatically)
      console.warn(`Skipping webhook with malformed address: ${webhook.address} (${error.message})`);
      return false;
    }
  });
  
  if (orphanedWebhooks.length > 0) {
    console.log(`\n🧹 Cleaning up ${orphanedWebhooks.length} orphaned webhook(s) from other environments:`);
    for (const orphaned of orphanedWebhooks) {
      try {
        console.log(`   Deleting: ${orphaned.topic} -> ${orphaned.address} (ID: ${orphaned.id})`);
        await deleteShopifyWebhook(shopDomain, accessToken, orphaned.id.toString());
        console.log(`   ✓ Deleted orphaned webhook ${orphaned.id}`);
      } catch (error: any) {
        console.error(`   ✗ Failed to delete orphaned webhook ${orphaned.id}:`, error.message);
        // Continue with other deletions even if one fails
      }
    }
    console.log('');
  }
  
  // PER-TOPIC REPLACEMENT STRATEGY
  // For each webhook: (1) cache old, (2) delete old, (3) create new, (4) rollback if failed
  // This avoids Shopify's duplicate topic/address constraint
  let replacedCount = 0;
  let deletedCount = 0;
  const failures: string[] = [];
  
  for (const required of requiredWebhooks) {
    console.log(`\n→ Replacing webhook: ${required.topic} → ${required.address}`);
    
    // Find existing webhook with BOTH matching topic AND address
    // This prevents accidentally deleting third-party integration webhooks
    const existing = existingWebhooks.find((w: any) => 
      w.topic === required.topic && w.address === required.address
    );
    
    if (!existing) {
      // No existing webhook for this topic+address combination - just create it
      try {
        console.log(`  No existing webhook found for this address, creating new...`);
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
    { topic: 'refunds/create', address: `${normalizedBaseUrl}/api/webhooks/shopify/refunds` },
    { topic: 'products/create', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
    { topic: 'products/update', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
    { topic: 'products/delete', address: `${normalizedBaseUrl}/api/webhooks/shopify/products` },
  ];

  try {
    const existingWebhooks = await listShopifyWebhooks(shopDomain, accessToken);
    
    // CLEANUP: Delete orphaned webhooks that point to different base URLs
    // This ensures each environment only manages its own webhooks
    const requiredTopics = new Set(requiredWebhooks.map(w => w.topic));
    const orphanedWebhooks = existingWebhooks.filter((webhook: any) => {
      // Check if this webhook is for one of our topics
      if (!requiredTopics.has(webhook.topic)) {
        return false; // Not our topic, leave it alone (could be third-party integration)
      }
      
      // Check if this webhook points to a different base URL
      try {
        const webhookUrl = new URL(webhook.address);
        const currentUrl = new URL(normalizedBaseUrl);
        return webhookUrl.host !== currentUrl.host;
      } catch (error: any) {
        // Malformed webhook address - log and skip (don't delete malformed webhooks automatically)
        console.warn(`Skipping webhook with malformed address: ${webhook.address} (${error.message})`);
        return false;
      }
    });
    
    if (orphanedWebhooks.length > 0) {
      console.log(`🧹 Cleaning up ${orphanedWebhooks.length} orphaned webhook(s) from other environments:`);
      for (const orphaned of orphanedWebhooks) {
        try {
          console.log(`   Deleting: ${orphaned.topic} -> ${orphaned.address} (ID: ${orphaned.id})`);
          await deleteShopifyWebhook(shopDomain, accessToken, orphaned.id.toString());
          console.log(`   ✓ Deleted orphaned webhook ${orphaned.id}`);
        } catch (error: any) {
          console.error(`   ✗ Failed to delete orphaned webhook ${orphaned.id}:`, error.message);
          // Continue with other deletions even if one fails
        }
      }
    }
    
    // Register required webhooks for this environment
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
