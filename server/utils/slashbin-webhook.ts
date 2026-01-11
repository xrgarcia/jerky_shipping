import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify Slashbin webhook signature using HMAC-SHA256
 * 
 * @param rawBody - The raw request body as a Buffer or string
 * @param signatureHeader - The X-Slashbin-Signature header value (format: sha256={signature})
 * @param secret - The Slashbin signing secret
 * @returns true if signature is valid, false otherwise
 */
export function verifySlashbinWebhook(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) {
    return false;
  }

  // Extract the signature from the header (format: sha256={signature})
  const signatureParts = signatureHeader.split('=');
  if (signatureParts.length !== 2 || signatureParts[0] !== 'sha256') {
    console.error('[Slashbin] Invalid signature format - expected sha256={signature}');
    return false;
  }
  
  const providedSignature = signatureParts[1];
  
  // Compute HMAC-SHA256 of the raw body
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
  const computedSignature = createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  
  // Use timing-safe comparison to prevent timing attacks
  try {
    const providedBuffer = Buffer.from(providedSignature, 'hex');
    const computedBuffer = Buffer.from(computedSignature, 'hex');
    
    if (providedBuffer.length !== computedBuffer.length) {
      return false;
    }
    
    return timingSafeEqual(providedBuffer, computedBuffer);
  } catch (error) {
    console.error('[Slashbin] Error comparing signatures:', error);
    return false;
  }
}

// In-memory set to track processed job IDs for idempotency
// In production, this should be persisted to a database
const processedJobIds = new Set<string>();

/**
 * Check if a job has already been processed (idempotency check)
 * 
 * @param jobId - The slashbin_job_id from the webhook payload
 * @returns true if already processed, false if new
 */
export function isJobAlreadyProcessed(jobId: string): boolean {
  return processedJobIds.has(jobId);
}

/**
 * Mark a job as processed
 * 
 * @param jobId - The slashbin_job_id from the webhook payload
 */
export function markJobAsProcessed(jobId: string): void {
  processedJobIds.add(jobId);
  
  // Cleanup old entries after reaching a threshold to prevent memory leaks
  if (processedJobIds.size > 10000) {
    const iterator = processedJobIds.values();
    // Remove oldest 20% of entries
    for (let i = 0; i < 2000; i++) {
      const oldest = iterator.next().value;
      if (oldest) {
        processedJobIds.delete(oldest);
      }
    }
  }
}
