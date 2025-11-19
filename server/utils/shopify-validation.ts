/**
 * Shopify credential validation utility
 * Validates SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN, and SHOPIFY_API_SECRET
 * Results are cached for 10 minutes to avoid repeated API calls
 */

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  lastChecked: Date;
  shopName?: string;
}

let cachedResult: ValidationResult | null = null;
let cacheExpiry: number = 0;

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Validate Shopify credentials by making a test API call
 * Results are cached for 10 minutes
 */
export async function validateShopifyCredentials(): Promise<ValidationResult> {
  const now = Date.now();
  
  // Return cached result if still valid
  if (cachedResult && now < cacheExpiry) {
    return cachedResult;
  }

  const errors: string[] = [];
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiSecret = process.env.SHOPIFY_API_SECRET;

  // Check if environment variables are defined
  if (!shopDomain || shopDomain.trim() === '') {
    errors.push('SHOPIFY_SHOP_DOMAIN is not defined');
  }
  if (!accessToken || accessToken.trim() === '') {
    errors.push('SHOPIFY_ADMIN_ACCESS_TOKEN is not defined');
  }
  if (!apiSecret || apiSecret.trim() === '') {
    errors.push('SHOPIFY_API_SECRET is not defined');
  }

  // If any are missing, return early with errors
  if (errors.length > 0) {
    const result: ValidationResult = {
      isValid: false,
      errors,
      lastChecked: new Date(),
    };
    
    // Cache the result
    cachedResult = result;
    cacheExpiry = now + CACHE_TTL_MS;
    
    return result;
  }

  // Make a test API call to validate credentials
  // We'll fetch shop info - a lightweight call that requires valid credentials
  try {
    const url = `https://${shopDomain}/admin/api/2024-01/shop.json`;
    
    const response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': accessToken!,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        errors.push('SHOPIFY_ADMIN_ACCESS_TOKEN is invalid (401 Unauthorized)');
      } else if (response.status === 403) {
        errors.push('SHOPIFY_ADMIN_ACCESS_TOKEN lacks required permissions (403 Forbidden)');
      } else if (response.status === 404) {
        errors.push('SHOPIFY_SHOP_DOMAIN is invalid (404 Not Found)');
      } else {
        errors.push(`Shopify API error: ${response.status} ${response.statusText}`);
      }
    }

    const data = await response.json();
    const shopName = data.shop?.name;

    const result: ValidationResult = {
      isValid: errors.length === 0,
      errors,
      lastChecked: new Date(),
      shopName: errors.length === 0 ? shopName : undefined,
    };

    // Cache the result
    cachedResult = result;
    cacheExpiry = now + CACHE_TTL_MS;

    return result;
  } catch (error) {
    errors.push(`Failed to connect to Shopify: ${error instanceof Error ? error.message : String(error)}`);
    
    const result: ValidationResult = {
      isValid: false,
      errors,
      lastChecked: new Date(),
    };
    
    // Cache the result
    cachedResult = result;
    cacheExpiry = now + CACHE_TTL_MS;
    
    return result;
  }
}

/**
 * Clear the validation cache (useful for testing or forcing re-validation)
 */
export function clearValidationCache(): void {
  cachedResult = null;
  cacheExpiry = 0;
}
