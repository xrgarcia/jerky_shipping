#!/usr/bin/env tsx
/**
 * Emergency cleanup script - Deletes ALL Shopify webhooks
 * Run with: npx tsx scripts/delete-all-shopify-webhooks.ts
 * 
 * WARNING: This will delete all webhooks including production ones.
 * Use this when you have duplicate webhooks with outdated secrets.
 */

async function listShopifyWebhooks(
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

async function deleteShopifyWebhook(
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

async function main() {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!shopDomain || !accessToken) {
    console.error('Error: Missing environment variables');
    console.error('Please ensure SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN are set');
    process.exit(1);
  }

  console.log(`\n🔥 DELETING ALL WEBHOOKS FROM ${shopDomain}...\n`);
  console.log('⚠️  WARNING: This will delete ALL webhooks, including production ones!');
  console.log('⚠️  You will need to re-register webhooks after this operation.\n');

  try {
    const webhooks = await listShopifyWebhooks(shopDomain, accessToken);
    
    console.log(`Found ${webhooks.length} webhook(s) to delete\n`);
    console.log('─'.repeat(120));
    
    if (webhooks.length === 0) {
      console.log('\nNo webhooks to delete. All clean!');
      return;
    }

    let deletedCount = 0;
    let failedCount = 0;
    
    for (const webhook of webhooks) {
      try {
        console.log(`\nDeleting webhook ${deletedCount + 1}/${webhooks.length}:`);
        console.log(`  ID:      ${webhook.id}`);
        console.log(`  Topic:   ${webhook.topic}`);
        console.log(`  Address: ${webhook.address}`);
        
        await deleteShopifyWebhook(shopDomain, accessToken, webhook.id.toString());
        deletedCount++;
        console.log(`  ✅ Deleted successfully`);
        
        // Rate limiting: wait 250ms between deletions
        await new Promise(resolve => setTimeout(resolve, 250));
        
      } catch (error: any) {
        failedCount++;
        console.log(`  ❌ Failed: ${error.message}`);
      }
    }
    
    console.log('\n' + '─'.repeat(120));
    console.log(`\n✅ Cleanup complete!`);
    console.log(`   Deleted: ${deletedCount}/${webhooks.length}`);
    if (failedCount > 0) {
      console.log(`   Failed:  ${failedCount}`);
    }
    console.log(`\n⚠️  IMPORTANT: Remember to re-register webhooks from the Operations dashboard!`);
    console.log('─'.repeat(120) + '\n');
    
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

main();
