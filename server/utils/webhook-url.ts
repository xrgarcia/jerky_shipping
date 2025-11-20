export function getWebhookBaseUrl(): string | null {
  // Allow explicit override via WEBHOOK_BASE_URL (but sanitize it)
  const envOverride = process.env.WEBHOOK_BASE_URL?.trim();
  if (envOverride) {
    const sanitized = envOverride.replace(/\/$/, ''); // Remove trailing slash
    if (sanitized && sanitized.startsWith('http')) {
      return sanitized;
    }
    console.log(`Warning: WEBHOOK_BASE_URL is set but invalid: "${envOverride}"`);
  }

  // Auto-detect based on environment
  const isProduction = process.env.REPLIT_DEPLOYMENT === '1';
  
  if (isProduction) {
    // Production deployment - use published .replit.app URL
    return 'https://jerkyshippping.replit.app';
  } else {
    // Development workspace - use REPLIT_DOMAINS
    // REPLIT_DOMAINS can be comma-separated, take only the FIRST domain
    const devDomains = process.env.REPLIT_DOMAINS?.trim();
    if (devDomains) {
      // Split by comma and take first domain
      const firstDomain = devDomains.split(',')[0].trim();
      if (firstDomain) {
        // Ensure it has https:// prefix and no trailing slash
        const url = firstDomain.startsWith('http') ? firstDomain : `https://${firstDomain}`;
        return url.replace(/\/$/, '');
      }
    }
  }

  return null;
}
