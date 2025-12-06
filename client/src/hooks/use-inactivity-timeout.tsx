import { useState, useEffect, useRef } from "react";
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

/**
 * Inactivity timeout hook using a fully ref-based controller pattern.
 * 
 * Key design principle: The main useEffect only depends on `enabled`.
 * All callbacks are stored in refs so they never cause effect re-runs.
 * Timer lifecycle is completely independent of React's render cycle.
 */
export function useInactivityTimeout({ onLogout, enabled = true }: UseInactivityTimeoutOptions) {
  // UI state - these trigger re-renders but don't affect timer logic
  const [showWarning, setShowWarning] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(60);

  // Refs for timer handles
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // Refs for state that timers need to read
  const isLoggingOutRef = useRef(false);
  const isWarningActiveRef = useRef(false);
  const onLogoutRef = useRef(onLogout);

  // Keep onLogout ref in sync
  useEffect(() => {
    onLogoutRef.current = onLogout;
  }, [onLogout]);

  // All timer functions defined once at mount time using refs
  // These never change, so they never cause effect re-runs
  const functionsRef = useRef({
    clearAllTimers: () => {
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
    },

    handleLogout: async () => {
      if (isLoggingOutRef.current) {
        console.log('[InactivityTimeout] Logout already in progress, skipping');
        return;
      }
      
      console.log('[InactivityTimeout] handleLogout called - starting logout process');
      isLoggingOutRef.current = true;
      isWarningActiveRef.current = false;
      functionsRef.current.clearAllTimers();
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
      onLogoutRef.current();
      
      console.log('[InactivityTimeout] Redirecting to /login');
      window.location.href = '/login';
    },

    startTimers: () => {
      if (isLoggingOutRef.current) {
        console.log('[InactivityTimeout] Cannot start timers - logout in progress');
        return;
      }
      
      if (isWarningActiveRef.current) {
        console.log('[InactivityTimeout] Cannot start timers - warning already active');
        return;
      }
      
      functionsRef.current.clearAllTimers();
      
      console.log('[InactivityTimeout] Starting timers - warning in', (INACTIVITY_TIMEOUT_MS - WARNING_BEFORE_MS) / 1000, 'seconds');
      
      // Show warning 1 minute before logout
      warningTimerRef.current = setTimeout(() => {
        if (isLoggingOutRef.current) return;
        
        console.log('[InactivityTimeout] Warning timer fired - showing dialog');
        isWarningActiveRef.current = true;
        setShowWarning(true);
        setSecondsRemaining(60);
        
        // Start countdown with local variable to avoid closure issues
        let countdown = 60;
        countdownRef.current = setInterval(() => {
          countdown -= 1;
          console.log('[InactivityTimeout] Countdown:', countdown);
          setSecondsRemaining(countdown);
          
          if (countdown <= 0) {
            console.log('[InactivityTimeout] Countdown reached 0 - triggering logout');
            if (countdownRef.current) {
              clearInterval(countdownRef.current);
              countdownRef.current = null;
            }
            functionsRef.current.handleLogout();
          }
        }, 1000);
      }, INACTIVITY_TIMEOUT_MS - WARNING_BEFORE_MS);

      // Backup timer
      logoutTimerRef.current = setTimeout(() => {
        console.log('[InactivityTimeout] Backup logout timer fired');
        functionsRef.current.handleLogout();
      }, INACTIVITY_TIMEOUT_MS);
    },

    stayLoggedIn: () => {
      if (isLoggingOutRef.current) return;
      console.log('[InactivityTimeout] Stay logged in clicked');
      
      isWarningActiveRef.current = false;
      setShowWarning(false);
      functionsRef.current.startTimers();
    }
  });

  // Main effect - ONLY depends on `enabled`
  // All functions are accessed via refs so they don't cause re-runs
  useEffect(() => {
    if (!enabled) {
      console.log('[InactivityTimeout] Disabled - clearing timers');
      functionsRef.current.clearAllTimers();
      isLoggingOutRef.current = false;
      isWarningActiveRef.current = false;
      return;
    }

    console.log('[InactivityTimeout] Enabled - setting up activity listeners');
    isLoggingOutRef.current = false;
    isWarningActiveRef.current = false;

    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click', 'wheel'];
    let lastUpdate = 0;
    const throttleMs = 1000;

    const handleActivity = () => {
      if (isLoggingOutRef.current || isWarningActiveRef.current) {
        return;
      }
      
      const now = Date.now();
      if (now - lastUpdate > throttleMs) {
        lastUpdate = now;
        functionsRef.current.startTimers();
      }
    };

    events.forEach(event => {
      document.addEventListener(event, handleActivity, { passive: true });
    });

    functionsRef.current.startTimers();

    return () => {
      console.log('[InactivityTimeout] Cleanup - removing listeners and timers');
      events.forEach(event => {
        document.removeEventListener(event, handleActivity);
      });
      functionsRef.current.clearAllTimers();
    };
  }, [enabled]); // ONLY enabled - no other deps

  // Warning dialog component
  const WarningDialog = () => (
    <AlertDialog 
      open={showWarning} 
      onOpenChange={(open) => {
        if (!open && !isLoggingOutRef.current) {
          functionsRef.current.stayLoggedIn();
        }
      }}
    >
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
            onClick={() => functionsRef.current.handleLogout()}
            className="gap-2"
            data-testid="button-logout-now"
          >
            <LogOut className="h-4 w-4" />
            Log Out Now
          </Button>
          <AlertDialogAction
            onClick={() => functionsRef.current.stayLoggedIn()}
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
    stayLoggedIn: functionsRef.current.stayLoggedIn,
    handleLogout: functionsRef.current.handleLogout,
    WarningDialog,
    resetActivity: functionsRef.current.startTimers
  };
}
