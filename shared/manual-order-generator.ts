/**
 * Manual Order Number Generator
 * 
 * Generates order numbers for manual/direct orders in the format:
 * 111-XXXXXXX-XXXXXXX with optional suffix (e.g., -SP, -RW)
 * 
 * This ensures all manually created orders follow the expected pattern
 * and will be correctly parsed by the SkuVault automation.
 */

export interface GeneratedOrderNumber {
  orderNumber: string;
  fullSaleId: string;
  isValid: boolean;
  validationError?: string;
}

export interface GenerateOrderOptions {
  suffix?: string;
}

const MANUAL_CHANNEL_ID = '111';
const ACCOUNT_PREFIX = '1-352444-5-13038';
const CHANNEL_ID = '480797';

/**
 * Generate a random 7-digit number as a string
 */
function generateRandomSegment(): string {
  const min = 1000000;
  const max = 9999999;
  return Math.floor(Math.random() * (max - min + 1) + min).toString();
}

/**
 * Validate a suffix format (uppercase letters only, optionally followed by digits)
 */
export function validateSuffix(suffix: string): { valid: boolean; error?: string } {
  if (!suffix) {
    return { valid: true };
  }
  
  // Suffix must start with a dash if provided
  const cleanSuffix = suffix.startsWith('-') ? suffix.slice(1) : suffix;
  
  // Must be uppercase letters, optionally followed by digits
  const suffixPattern = /^[A-Z]+\d*$/;
  
  if (!suffixPattern.test(cleanSuffix)) {
    return { 
      valid: false, 
      error: 'Suffix must be uppercase letters only (e.g., SP, RW, DH), optionally followed by numbers' 
    };
  }
  
  if (cleanSuffix.length > 10) {
    return { valid: false, error: 'Suffix must be 10 characters or less' };
  }
  
  return { valid: true };
}

/**
 * Generate a manual order number in the format: 111-XXXXXXX-XXXXXXX[-SUFFIX]
 */
export function generateManualOrderNumber(options?: GenerateOrderOptions): GeneratedOrderNumber {
  const segment1 = generateRandomSegment();
  const segment2 = generateRandomSegment();
  
  let orderNumber = `${MANUAL_CHANNEL_ID}-${segment1}-${segment2}`;
  
  // Add suffix if provided
  if (options?.suffix) {
    const suffixValidation = validateSuffix(options.suffix);
    if (!suffixValidation.valid) {
      return {
        orderNumber: '',
        fullSaleId: '',
        isValid: false,
        validationError: suffixValidation.error
      };
    }
    
    const cleanSuffix = options.suffix.startsWith('-') ? options.suffix : `-${options.suffix}`;
    orderNumber += cleanSuffix.toUpperCase();
  }
  
  // Construct the full sale ID
  const fullSaleId = `${ACCOUNT_PREFIX}-${CHANNEL_ID}-${orderNumber}`;
  
  // Validate the generated order number matches expected patterns
  const validation = validateManualOrderNumber(orderNumber);
  
  return {
    orderNumber,
    fullSaleId,
    isValid: validation.valid,
    validationError: validation.error
  };
}

/**
 * Validate that an order number matches the manual order pattern
 */
export function validateManualOrderNumber(orderNumber: string): { valid: boolean; error?: string } {
  // Pattern: 111-XXXXXXX-XXXXXXX with optional suffix
  const manualPattern = /^111-\d{7}-\d{7}(?:-[A-Z]+\d*)?$/;
  
  if (!manualPattern.test(orderNumber)) {
    return {
      valid: false,
      error: 'Order number must be in format 111-XXXXXXX-XXXXXXX (with optional -SUFFIX)'
    };
  }
  
  return { valid: true };
}

/**
 * Validate the full sale ID matches expected structure
 */
export function validateFullSaleId(saleId: string): { valid: boolean; error?: string; orderNumber?: string } {
  // Pattern for manual orders with our account
  const fullPattern = /^1-352444-\d+-\d+-(?:480797|138162)-(111-\d{7}-\d{7}(?:-[A-Z]+\d*)?)$/;
  
  const match = saleId.match(fullPattern);
  
  if (!match) {
    return {
      valid: false,
      error: 'Sale ID does not match expected manual order format'
    };
  }
  
  return { 
    valid: true,
    orderNumber: match[1]
  };
}

/**
 * Parse a sale ID to extract components (simplified for manual orders)
 */
export interface ParsedSaleId {
  accountId: string;
  channelId: string;
  orderNumber: string;
  marketplace: 'MANUAL';
  success: boolean;
  error?: string;
}

export function parseManualSaleId(saleId: string): ParsedSaleId {
  const basePattern = /^(1-352444-\d+-\d+)-(\d+)-(.+)$/;
  const match = saleId.match(basePattern);
  
  if (!match) {
    return {
      accountId: '',
      channelId: '',
      orderNumber: '',
      marketplace: 'MANUAL',
      success: false,
      error: 'Could not parse sale ID structure'
    };
  }
  
  const [, accountId, channelId, orderPart] = match;
  
  // For manual orders, validate the order part
  const validation = validateManualOrderNumber(orderPart);
  
  return {
    accountId,
    channelId,
    orderNumber: orderPart,
    marketplace: 'MANUAL',
    success: validation.valid,
    error: validation.error
  };
}
