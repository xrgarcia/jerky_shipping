import { useState, useEffect, useCallback, useRef } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Clock, LogOut } from "lucide-react";

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const WARNING_BEFORE_MS = 60 * 1000; // Show warning 1 minute before logout

interface UseInactivityTimeoutOptions {
  onLogout: () => void;
  enabled?: boolean;
}

export function useInactivityTimeout({ onLogout, enabled = true }: UseInactivityTimeoutOptions) {
  const [showWarning, setShowWarning] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(60);
  const lastActivityRef = useRef<number>(Date.now());
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isLoggingOutRef = useRef(false); // Prevent stayLoggedIn during logout

  const clearAllTimers = useCallback(() => {
    if (warningTimerRef.current) {
      clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
    if (logoutTimerRef.current) {
      clearTimeout(logoutTimerRef.current);
      logoutTimerRef.current = null;
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  const handleLogout = useCallback(async () => {
    // Prevent multiple logout calls
    if (isLoggingOutRef.current) {
      console.log('[InactivityTimeout] Logout already in progress, skipping');
      return;
    }
    
    console.log('[InactivityTimeout] handleLogout called - starting logout process');
    isLoggingOutRef.current = true; // Prevent stayLoggedIn from being called
    clearAllTimers();
    setShowWarning(false);
    
    console.log('[InactivityTimeout] Calling /api/auth/logout');
    try {
      const response = await fetch('/api/auth/logout', { 
        method: 'POST',
        credentials: 'include'
      });
      console.log('[InactivityTimeout] Logout API response:', response.status);
    } catch (error) {
      console.error('[InactivityTimeout] Logout request failed:', error);
    }
    
    console.log('[InactivityTimeout] Calling onLogout callback');
    onLogout();
    
    console.log('[InactivityTimeout] Redirecting to /login');
    // Use window.location for redirect to ensure full page reload
    window.location.href = '/login';
  }, [clearAllTimers, onLogout]);

  const startTimers = useCallback(() => {
    clearAllTimers();
    
    console.log('[InactivityTimeout] Starting timers - warning in', (INACTIVITY_TIMEOUT_MS - WARNING_BEFORE_MS) / 1000, 'seconds');
    
    // Set timer to show warning (9 minutes after last activity)
    warningTimerRef.current = setTimeout(() => {
      console.log('[InactivityTimeout] Warning timer fired - showing dialog');
      setShowWarning(true);
      setSecondsRemaining(60);
      
      // Start countdown
      countdownRef.current = setInterval(() => {
        setSecondsRemaining(prev => {
          const newValue = prev - 1;
          console.log('[InactivityTimeout] Countdown:', newValue);
          if (newValue <= 0) {
            // Clear the interval BEFORE calling handleLogout to prevent race conditions
            if (countdownRef.current) {
              clearInterval(countdownRef.current);
              countdownRef.current = null;
            }
            console.log('[InactivityTimeout] Countdown reached 0 - triggering logout');
            handleLogout();
            return 0;
          }
          return newValue;
        });
      }, 1000);
    }, INACTIVITY_TIMEOUT_MS - WARNING_BEFORE_MS);

    // Backup timer for auto-logout (10 minutes after last activity)
    // This is a fallback in case the countdown doesn't trigger
    logoutTimerRef.current = setTimeout(() => {
      console.log('[InactivityTimeout] Backup logout timer fired');
      handleLogout();
    }, INACTIVITY_TIMEOUT_MS);
  }, [clearAllTimers, handleLogout]);

  const resetActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    
    // If warning is showing and user interacts, dismiss it and restart timers
    if (showWarning) {
      setShowWarning(false);
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    }
    
    startTimers();
  }, [showWarning, startTimers]);

  const stayLoggedIn = useCallback(() => {
    setShowWarning(false);
    resetActivity();
  }, [resetActivity]);

  useEffect(() => {
    if (!enabled) {
      clearAllTimers();
      return;
    }

    // Activity events to track
    const events = [
      'mousedown',
      'mousemove',
      'keydown',
      'scroll',
      'touchstart',
      'click',
      'wheel'
    ];

    // Throttle activity updates to prevent excessive timer resets
    let lastUpdate = 0;
    const throttleMs = 1000; // Only update once per second max

    const handleActivity = () => {
      const now = Date.now();
      if (now - lastUpdate > throttleMs) {
        lastUpdate = now;
        resetActivity();
      }
    };

    // Add event listeners
    events.forEach(event => {
      document.addEventListener(event, handleActivity, { passive: true });
    });

    // Start initial timers
    startTimers();

    return () => {
      events.forEach(event => {
        document.removeEventListener(event, handleActivity);
      });
      clearAllTimers();
    };
  }, [enabled, resetActivity, startTimers, clearAllTimers]);

  // Warning dialog component
  const WarningDialog = () => (
    <AlertDialog open={showWarning} onOpenChange={(open) => {
      // Only call stayLoggedIn if dialog is closing and we're not in the middle of logout
      if (!open && !isLoggingOutRef.current) {
        stayLoggedIn();
      }
    }}>
      <AlertDialogContent className="max-w-md" data-testid="dialog-inactivity-warning">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-amber-500" />
            Session Timeout Warning
          </AlertDialogTitle>
          <AlertDialogDescription className="text-base">
            You will be logged out in <span className="font-bold text-foreground">{secondsRemaining} seconds</span> due to inactivity.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={handleLogout}
            className="gap-2"
            data-testid="button-logout-now"
          >
            <LogOut className="h-4 w-4" />
            Log Out Now
          </Button>
          <AlertDialogAction
            onClick={stayLoggedIn}
            data-testid="button-stay-logged-in"
          >
            Stay Logged In
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return {
    showWarning,
    secondsRemaining,
    stayLoggedIn,
    handleLogout,
    WarningDialog,
    resetActivity
  };
}
