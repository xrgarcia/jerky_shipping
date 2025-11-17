import { storage } from "../storage";
import { log } from "../vite";

/**
 * Fetch products from Shopify Admin API
 * Uses pagination to get all products
 */
async function fetchShopifyProducts(
  shopDomain: string,
  accessToken: string,
  limit: number = 50
): Promise<any[]> {
  const allProducts: any[] = [];
  let pageInfo: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const url = pageInfo
      ? `https://${shopDomain}/admin/api/2024-01/products.json?limit=${limit}&page_info=${pageInfo}`
      : `https://${shopDomain}/admin/api/2024-01/products.json?limit=${limit}`;

    const response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch products: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    allProducts.push(...(data.products || []));

    // Check for pagination
    const linkHeader = response.headers.get('Link');
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch && nextMatch[1]) {
        const nextUrl = new URL(nextMatch[1]);
        pageInfo = nextUrl.searchParams.get('page_info');
      } else {
        hasNextPage = false;
      }
    } else {
      hasNextPage = false;
    }
  }

  return allProducts;
}

/**
 * Bootstrap existing products from Shopify
 * This runs once on server startup to populate the database with products
 * that were created before webhook registration
 */
export async function bootstrapProductsFromShopify(): Promise<void> {
  try {
    const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
    const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

    if (!shopDomain || !accessToken) {
      log("Skipping product bootstrap - Shopify credentials not configured");
      return;
    }

    log("Fetching products from Shopify...");

    const products = await fetchShopifyProducts(shopDomain, accessToken);

    if (products.length === 0) {
      log("No products found in Shopify");
      return;
    }

    log(`Processing ${products.length} products from Shopify...`);

    let productsCreated = 0;
    let productsUpdated = 0;
    let variantsCreated = 0;

    for (const shopifyProduct of products) {
      try {
        // Check if product exists (including soft-deleted) to determine create vs update
        const db = await import("../db").then(m => m.db);
        const { products: productsTable } = await import("@shared/schema");
        const { eq } = await import("drizzle-orm");
        const existingProducts = await db
          .select()
          .from(productsTable)
          .where(eq(productsTable.id, shopifyProduct.id.toString()));
        const existing = existingProducts[0];

        const productData = {
          id: shopifyProduct.id.toString(),
          title: shopifyProduct.title,
          imageUrl: shopifyProduct.image?.src || shopifyProduct.images?.[0]?.src || null,
          status: shopifyProduct.status || 'active',
          shopifyCreatedAt: new Date(shopifyProduct.created_at),
          shopifyUpdatedAt: new Date(shopifyProduct.updated_at),
          deletedAt: null, // Resurrect if previously deleted
        };

        await storage.upsertProduct(productData);

        if (existing) {
          productsUpdated++;
        } else {
          productsCreated++;
        }

        // Get current variant IDs from Shopify
        const shopifyVariants = shopifyProduct.variants || [];
        const shopifyVariantIds = new Set(shopifyVariants.map((v: any) => v.id.toString()));

        // Get existing variants (including soft-deleted ones for reconciliation)
        const { productVariants } = await import("@shared/schema");
        const existingVariants = await db
          .select()
          .from(productVariants)
          .where(eq(productVariants.productId, shopifyProduct.id.toString()));

        // Soft-delete variants that are no longer in Shopify payload
        for (const existingVariant of existingVariants) {
          if (!shopifyVariantIds.has(existingVariant.id) && !existingVariant.deletedAt) {
            await storage.softDeleteProductVariant(existingVariant.id);
          }
        }

        // Upsert all current variants (resurrect if previously deleted)
        for (const variant of shopifyVariants) {
          const variantData = {
            id: variant.id.toString(),
            productId: shopifyProduct.id.toString(),
            sku: variant.sku || null,
            barCode: variant.barcode || null,
            title: variant.title || 'Default',
            imageUrl: variant.image_id 
              ? shopifyProduct.images?.find((img: any) => img.id === variant.image_id)?.src || null
              : null,
            price: variant.price,
            inventoryQuantity: variant.inventory_quantity || 0,
            shopifyCreatedAt: new Date(variant.created_at),
            shopifyUpdatedAt: new Date(variant.updated_at),
            deletedAt: null, // Resurrect if previously deleted
          };

          await storage.upsertProductVariant(variantData);
          variantsCreated++;
        }
      } catch (productError: any) {
        console.error(`Error processing product ${shopifyProduct.id}:`, productError.message);
      }
    }

    log(`Bootstrapped ${productsCreated} new products, updated ${productsUpdated} existing products, and synced ${variantsCreated} variants`);
  } catch (error) {
    console.error("Error bootstrapping products from Shopify:", error);
    // Don't throw - let server continue even if bootstrap fails
  }
}
