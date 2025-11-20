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
    const devDomain = process.env.REPLIT_DOMAINS?.trim();
    if (devDomain) {
      // Ensure it has https:// prefix and no trailing slash
      const url = devDomain.startsWith('http') ? devDomain : `https://${devDomain}`;
      return url.replace(/\/$/, '');
    }
  }

  return null;
}
