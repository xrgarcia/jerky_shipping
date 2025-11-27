/**
 * Manual Order Number Generator for Customer Service
 * 
 * Generates order numbers for manual/phone orders in Shopify format:
 * JK{4digits}-{6digits}-{initials}
 * 
 * Example: JK3825-112525-JB
 * 
 * This ensures all manually created orders follow the expected pattern
 * and will be correctly parsed by the SkuVault/ShipStation automation.
 * 
 * IMPORTANT: Initials must be letters only (no trailing digits)
 * to avoid confusion with shipment ID detection.
 */

export interface GeneratedOrderNumber {
  orderNumber: string;
  isValid: boolean;
  validationError?: string;
}

export interface GenerateOrderOptions {
  initials?: string;
}

/**
 * Generate a random 4-digit number as a string (first segment)
 */
function generateFirstSegment(): string {
  const min = 1000;
  const max = 9999;
  return Math.floor(Math.random() * (max - min + 1) + min).toString();
}

/**
 * Generate a random 6-digit number as a string (second segment)
 */
function generateSecondSegment(): string {
  const min = 100000;
  const max = 999999;
  return Math.floor(Math.random() * (max - min + 1) + min).toString();
}

/**
 * Validate initials format (2-3 uppercase letters only, NO trailing digits)
 * 
 * CRITICAL: Trailing digits like "JB1" cause parsing issues because
 * the automation may confuse them with shipment IDs (8+ digits at end get stripped)
 */
export function validateInitials(initials: string): { valid: boolean; error?: string } {
  if (!initials) {
    return { valid: false, error: 'Initials are required (e.g., JB, SP, RW)' };
  }
  
  const cleanInitials = initials.trim().toUpperCase();
  
  // Must be 2-3 uppercase letters ONLY - no digits allowed
  const initialsPattern = /^[A-Z]{2,3}$/;
  
  if (!initialsPattern.test(cleanInitials)) {
    if (/\d/.test(cleanInitials)) {
      return { 
        valid: false, 
        error: 'Initials must be letters only - no numbers (e.g., use JB not JB1)' 
      };
    }
    return { 
      valid: false, 
      error: 'Initials must be 2-3 uppercase letters (e.g., JB, SP, RW)' 
    };
  }
  
  return { valid: true };
}

/**
 * Generate a manual order number in the format: JK{4digits}-{6digits}-{initials}
 * Example: JK3825-112525-JB
 */
export function generateManualOrderNumber(options?: GenerateOrderOptions): GeneratedOrderNumber {
  // Validate initials if provided
  if (options?.initials) {
    const initialsValidation = validateInitials(options.initials);
    if (!initialsValidation.valid) {
      return {
        orderNumber: '',
        isValid: false,
        validationError: initialsValidation.error
      };
    }
  }
  
  const segment1 = generateFirstSegment();
  const segment2 = generateSecondSegment();
  const initials = options?.initials?.trim().toUpperCase() || generateDefaultInitials();
  
  const orderNumber = `JK${segment1}-${segment2}-${initials}`;
  
  // Validate the generated order number matches expected pattern
  const validation = validateManualOrderNumber(orderNumber);
  
  return {
    orderNumber,
    isValid: validation.valid,
    validationError: validation.error
  };
}

/**
 * Generate default initials (random 2 uppercase letters)
 */
function generateDefaultInitials(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return letters.charAt(Math.floor(Math.random() * 26)) + 
         letters.charAt(Math.floor(Math.random() * 26));
}

/**
 * Validate that an order number matches the manual order pattern
 * Pattern: JK{4digits}-{6digits}-{2-3 letters}
 */
export function validateManualOrderNumber(orderNumber: string): { valid: boolean; error?: string } {
  // Pattern: JK followed by 4 digits, dash, 6 digits, dash, 2-3 letters (no digits!)
  const manualPattern = /^JK\d{4}-\d{6}-[A-Z]{2,3}$/;
  
  if (!manualPattern.test(orderNumber)) {
    // Provide specific error messages
    if (!orderNumber.startsWith('JK')) {
      return { valid: false, error: 'Order number must start with JK' };
    }
    if (!/^JK\d{4}/.test(orderNumber)) {
      return { valid: false, error: 'Order number must have 4 digits after JK (e.g., JK3825)' };
    }
    if (!/^JK\d{4}-\d{6}/.test(orderNumber)) {
      return { valid: false, error: 'Order number must have 6 digits in the middle segment (e.g., JK3825-112525)' };
    }
    if (/^JK\d{4}-\d{6}-[A-Z]+\d+$/.test(orderNumber)) {
      return { valid: false, error: 'Initials cannot end with numbers - use letters only (e.g., JB not JB1)' };
    }
    return {
      valid: false,
      error: 'Order number must be in format JK####-######-XX (e.g., JK3825-112525-JB)'
    };
  }
  
  return { valid: true };
}

/**
 * Validate a user-entered order number for the manual channel
 * This is for CS to check if their custom order number will parse correctly
 */
export function validateUserOrderNumber(orderNumber: string): { 
  valid: boolean; 
  error?: string;
  suggestion?: string;
} {
  if (!orderNumber || !orderNumber.trim()) {
    return { valid: false, error: 'Order number is required' };
  }
  
  const cleaned = orderNumber.trim().toUpperCase();
  const validation = validateManualOrderNumber(cleaned);
  
  if (!validation.valid) {
    // Check if it's close and provide a suggestion
    const trailingDigitMatch = cleaned.match(/^(JK\d{4}-\d{6}-[A-Z]+)\d+$/);
    if (trailingDigitMatch) {
      return {
        valid: false,
        error: 'Initials cannot end with numbers - they may be confused with shipment IDs',
        suggestion: trailingDigitMatch[1]
      };
    }
  }
  
  return validation;
}
