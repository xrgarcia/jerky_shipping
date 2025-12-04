/**
 * Workstation Guard - Prevents users from packing on the wrong workstation
 * 
 * When a user selects a station, the station ID is stored in localStorage with a TTL of midnight.
 * On page load, we compare the user's assigned station with the stored workstation ID.
 * If they don't match, we block packing and show an actionable message.
 */

const WORKSTATION_KEY = 'jerky_workstation_id';
const WORKSTATION_NAME_KEY = 'jerky_workstation_name';
const WORKSTATION_EXPIRY_KEY = 'jerky_workstation_expiry';

/**
 * Get the timestamp for midnight tonight (when workstation assignment should expire)
 */
function getMidnightTimestamp(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0); // Next midnight
  return midnight.getTime();
}

/**
 * Store the workstation ID in localStorage with TTL of midnight
 */
export function setWorkstationId(stationId: string, stationName: string): void {
  try {
    localStorage.setItem(WORKSTATION_KEY, stationId);
    localStorage.setItem(WORKSTATION_NAME_KEY, stationName);
    localStorage.setItem(WORKSTATION_EXPIRY_KEY, getMidnightTimestamp().toString());
  } catch (e) {
    console.error('[WorkstationGuard] Failed to store workstation ID:', e);
  }
}

/**
 * Get the stored workstation ID (null if expired or not set)
 */
export function getWorkstationId(): string | null {
  try {
    const expiry = localStorage.getItem(WORKSTATION_EXPIRY_KEY);
    if (!expiry) return null;
    
    // Check if expired
    if (Date.now() > parseInt(expiry, 10)) {
      clearWorkstationId();
      return null;
    }
    
    return localStorage.getItem(WORKSTATION_KEY);
  } catch (e) {
    console.error('[WorkstationGuard] Failed to read workstation ID:', e);
    return null;
  }
}

/**
 * Get the stored workstation name (null if expired or not set)
 */
export function getWorkstationName(): string | null {
  try {
    const expiry = localStorage.getItem(WORKSTATION_EXPIRY_KEY);
    if (!expiry) return null;
    
    // Check if expired
    if (Date.now() > parseInt(expiry, 10)) {
      clearWorkstationId();
      return null;
    }
    
    return localStorage.getItem(WORKSTATION_NAME_KEY);
  } catch (e) {
    console.error('[WorkstationGuard] Failed to read workstation name:', e);
    return null;
  }
}

/**
 * Clear the stored workstation ID
 */
export function clearWorkstationId(): void {
  try {
    localStorage.removeItem(WORKSTATION_KEY);
    localStorage.removeItem(WORKSTATION_NAME_KEY);
    localStorage.removeItem(WORKSTATION_EXPIRY_KEY);
  } catch (e) {
    console.error('[WorkstationGuard] Failed to clear workstation ID:', e);
  }
}

/**
 * Check if user's assigned station matches the workstation
 * Returns mismatch info if there's a problem, null if OK
 */
export function checkWorkstationMismatch(
  userStationId: string,
  userStationName: string
): { workstationId: string; workstationName: string } | null {
  const storedId = getWorkstationId();
  const storedName = getWorkstationName();
  
  // No stored workstation = first time setup, allow and store
  if (!storedId) {
    return null;
  }
  
  // Check if user's station matches the workstation
  if (storedId !== userStationId) {
    return {
      workstationId: storedId,
      workstationName: storedName || 'Unknown Station',
    };
  }
  
  return null;
}
