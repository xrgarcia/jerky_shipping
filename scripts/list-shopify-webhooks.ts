#!/usr/bin/env tsx
/**
 * Diagnostic script to list all Shopify webhooks currently registered
 * Run with: npx tsx scripts/list-shopify-webhooks.ts
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

async function main() {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!shopDomain || !accessToken) {
    console.error('Error: Missing environment variables');
    console.error('Please ensure SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN are set');
    process.exit(1);
  }

  console.log(`\n🔍 Fetching webhooks from ${shopDomain}...\n`);

  try {
    const webhooks = await listShopifyWebhooks(shopDomain, accessToken);
    
    console.log(`Found ${webhooks.length} registered webhook(s):\n`);
    console.log('─'.repeat(120));
    
    if (webhooks.length === 0) {
      console.log('No webhooks registered.');
    } else {
      // Group by topic for easier analysis
      const byTopic = new Map<string, any[]>();
      
      for (const webhook of webhooks) {
        if (!byTopic.has(webhook.topic)) {
          byTopic.set(webhook.topic, []);
        }
        byTopic.get(webhook.topic)!.push(webhook);
      }
      
      for (const [topic, webhookList] of byTopic.entries()) {
        console.log(`\n📌 Topic: ${topic} (${webhookList.length} registration${webhookList.length > 1 ? 's' : ''})`);
        
        if (webhookList.length > 1) {
          console.log('   ⚠️  DUPLICATE DETECTED - Multiple webhooks for same topic!');
        }
        
        for (const webhook of webhookList) {
          console.log(`   ID:      ${webhook.id}`);
          console.log(`   Address: ${webhook.address}`);
          console.log(`   Created: ${webhook.created_at}`);
          console.log(`   Updated: ${webhook.updated_at}`);
          console.log('   ' + '─'.repeat(100));
        }
      }
      
      // Summary
      console.log('\n📊 SUMMARY:');
      console.log(`   Total webhooks: ${webhooks.length}`);
      console.log(`   Unique topics: ${byTopic.size}`);
      
      const duplicates = Array.from(byTopic.entries()).filter(([_, list]) => list.length > 1);
      if (duplicates.length > 0) {
        console.log(`\n   ⚠️  DUPLICATES FOUND:`);
        for (const [topic, list] of duplicates) {
          console.log(`      - ${topic}: ${list.length} registrations`);
        }
        console.log(`\n   ℹ️  Duplicate webhooks with different secrets will cause verification failures.`);
        console.log(`      Use the Operations dashboard to re-register webhooks and remove duplicates.`);
      }
    }
    
    console.log('\n' + '─'.repeat(120) + '\n');
    
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

main();
