import { useEffect, useState } from 'react';
import type { AppState } from '@shared/types';
import LoginPage from './pages/LoginPage';
import StationPage from './pages/StationPage';
import DashboardPage from './pages/DashboardPage';

declare global {
  interface Window {
    electronAPI: {
      getState: () => Promise<AppState>;
      onStateChange: (callback: (state: AppState) => void) => () => void;
      auth: {
        login: () => Promise<{ success: boolean; error?: string }>;
        logout: () => Promise<{ success: boolean; error?: string }>;
      };
      station: {
        list: () => Promise<{ success: boolean; data?: unknown[]; error?: string }>;
        claim: (stationId: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;
        release: () => Promise<{ success: boolean; error?: string }>;
        create: (data: { name: string; locationHint?: string }) => Promise<{ success: boolean; data?: unknown; error?: string }>;
      };
      printer: {
        discover: () => Promise<{ success: boolean; data?: unknown[]; error?: string }>;
        list: () => Promise<{ success: boolean; data?: { id: string; name: string; systemName: string; isDefault: boolean; status: string }[]; error?: string }>;
        register: (data: { name: string; systemName: string; status?: string }) => Promise<{ success: boolean; data?: unknown; error?: string }>;
        setDefault: (printerId: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;
      };
      ws: {
        connect: () => Promise<{ success: boolean; error?: string }>;
        disconnect: () => Promise<{ success: boolean; error?: string }>;
      };
      job: {
        retry: (jobId: string) => Promise<{ success: boolean; error?: string }>;
      };
      environment: {
        list: () => Promise<{ success: boolean; data?: { name: string; displayName: string; serverUrl: string }[]; error?: string }>;
        get: () => Promise<{ success: boolean; data?: string; error?: string }>;
        set: (envName: string) => Promise<{ success: boolean; error?: string }>;
      };
    };
  }
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      try {
        const initialState = await window.electronAPI.getState();
        setState(initialState);
      } catch (error) {
        console.error('Failed to get initial state:', error);
      } finally {
        setLoading(false);
      }
    };

    init();

    const unsubscribe = window.electronAPI.onStateChange((newState) => {
      setState(newState);
    });

    return () => unsubscribe();
  }, []);

  if (loading || !state) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!state.auth.isAuthenticated) {
    return <LoginPage />;
  }

  if (!state.session) {
    return <StationPage state={state} />;
  }

  return <DashboardPage state={state} />;
}

export default App;
