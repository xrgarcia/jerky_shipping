#!/usr/bin/env node
/**
 * Build script to generate OAuth credentials file at build time.
 * This creates a JSON file that the app reads at runtime.
 */

const fs = require('fs');
const path = require('path');

const outputPath = path.join(__dirname, '../src/shared/oauth-credentials.json');

const clientId = process.env.DESKTOP_OAUTH_CLIENT_ID || '';
const clientSecret = process.env.DESKTOP_OAUTH_CLIENT_SECRET || '';

if (!clientId) {
  console.warn('⚠️  WARNING: DESKTOP_OAUTH_CLIENT_ID not set - OAuth will not work');
}
if (!clientSecret) {
  console.warn('⚠️  WARNING: DESKTOP_OAUTH_CLIENT_SECRET not set - OAuth will not work');
}

const credentials = {
  clientId,
  clientSecret
};

fs.writeFileSync(outputPath, JSON.stringify(credentials, null, 2));

console.log('✅ OAuth credentials generated');
console.log(`   Client ID: ${clientId ? clientId.substring(0, 20) + '...' : '(empty)'}`);
console.log(`   Client Secret: ${clientSecret ? '***' + clientSecret.slice(-4) : '(empty)'}`);
