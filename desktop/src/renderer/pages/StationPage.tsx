import { useState, useEffect } from 'react';
import { MapPin, Loader2, LogOut, RefreshCw } from 'lucide-react';
import type { AppState, Station } from '@shared/types';

interface StationPageProps {
  state: AppState;
}

function StationPage({ state }: StationPageProps) {
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStations = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const result = await window.electronAPI.station.list();
      if (result.success && result.data) {
        setStations(result.data as Station[]);
      } else {
        setError(result.error || 'Failed to load stations');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStations();
  }, []);

  const handleClaim = async (stationId: string) => {
    setClaiming(stationId);
    setError(null);

    try {
      const result = await window.electronAPI.station.claim(stationId);
      if (!result.success) {
        setError(result.error || 'Failed to claim station');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to claim station');
    } finally {
      setClaiming(null);
    }
  };

  const handleLogout = async () => {
    await window.electronAPI.auth.logout();
  };

  return (
    <div className="h-full flex flex-col">
      <div className="h-12 drag-region bg-[#1a1a1a] border-b border-[#333] flex items-center justify-between px-4">
        <div className="w-20" />
        <span className="text-sm font-medium text-white">Select Station</span>
        <button
          onClick={handleLogout}
          data-testid="button-logout"
          className="p-2 rounded-lg hover:bg-[#333] transition-colors no-drag"
          title="Sign out"
        >
          <LogOut className="w-4 h-4 text-[#999]" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm text-[#999]">
              Signed in as <span className="text-white">{state.auth.user?.displayName}</span>
            </p>
          </div>
          <button
            onClick={loadStations}
            disabled={loading}
            data-testid="button-refresh-stations"
            className="p-2 rounded-lg hover:bg-[#333] transition-colors"
            title="Refresh stations"
          >
            <RefreshCw className={`w-4 h-4 text-[#999] ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {loading && stations.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-primary-500 animate-spin" />
          </div>
        ) : stations.length === 0 ? (
          <div className="text-center py-12">
            <MapPin className="w-12 h-12 text-[#444] mx-auto mb-3" />
            <p className="text-[#999]">No stations available</p>
            <p className="text-sm text-[#666] mt-1">Contact your admin to set up packing stations</p>
          </div>
        ) : (
          <div className="space-y-3">
            {stations.map((station) => (
              <button
                key={station.id}
                onClick={() => handleClaim(station.id)}
                disabled={claiming !== null || !station.isActive}
                data-testid={`button-claim-station-${station.id}`}
                className={`w-full p-4 rounded-xl border transition-all text-left ${
                  station.isActive
                    ? 'bg-[#242424] border-[#333] hover:bg-[#2a2a2a] hover:border-primary-500/50'
                    : 'bg-[#1f1f1f] border-[#2a2a2a] opacity-50 cursor-not-allowed'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-white">{station.name}</h3>
                      {!station.isActive && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[#333] text-[#999]">
                          Inactive
                        </span>
                      )}
                    </div>
                    {station.location && (
                      <p className="text-sm text-[#999] mt-1 flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {station.location}
                      </p>
                    )}
                  </div>
                  {claiming === station.id ? (
                    <Loader2 className="w-5 h-5 text-primary-500 animate-spin" />
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default StationPage;
