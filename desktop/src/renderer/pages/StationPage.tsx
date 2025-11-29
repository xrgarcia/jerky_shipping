import { useState, useEffect } from 'react';
import { MapPin, Loader2, LogOut, RefreshCw, Plus, X, Wifi, WifiOff } from 'lucide-react';
import type { AppState, Station } from '@shared/types';

interface StationPageProps {
  state: AppState;
}

function StationPage({ state }: StationPageProps) {
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newStationName, setNewStationName] = useState('');
  const [newStationLocation, setNewStationLocation] = useState('');
  const [creating, setCreating] = useState(false);

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

  const handleCreateStation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStationName.trim()) return;
    
    setCreating(true);
    setError(null);
    
    try {
      const result = await window.electronAPI.station.create({
        name: newStationName.trim(),
        locationHint: newStationLocation.trim() || undefined,
      });
      
      if (result.success) {
        setNewStationName('');
        setNewStationLocation('');
        setShowCreateForm(false);
        await loadStations();
      } else {
        setError(result.error || 'Failed to create station');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create station');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="h-12 drag-region bg-[#1a1a1a] border-b border-[#333] flex items-center justify-between px-4">
        <div className="flex items-center gap-2 no-drag w-20">
          {state.connectionStatus === 'connected' ? (
            <div className="relative">
              <Wifi className="w-4 h-4 text-green-500" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-500 rounded-full" />
            </div>
          ) : state.connectionStatus === 'connecting' || state.connectionStatus === 'reconnecting' ? (
            <div className="relative">
              <Wifi className="w-4 h-4 text-orange-500 animate-pulse" />
            </div>
          ) : (
            <WifiOff className="w-4 h-4 text-red-500" />
          )}
        </div>
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
              Signed in as <span className="text-white">{state.auth.user?.displayName || state.auth.user?.email}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCreateForm(true)}
              disabled={showCreateForm}
              data-testid="button-create-station"
              className="p-2 rounded-lg hover:bg-[#333] transition-colors disabled:opacity-50"
              title="Create station"
            >
              <Plus className="w-4 h-4 text-[#999]" />
            </button>
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
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Create Station Form */}
        {showCreateForm && (
          <div className="mb-4 p-4 bg-[#242424] border border-[#333] rounded-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium text-white">Create New Station</h3>
              <button
                onClick={() => setShowCreateForm(false)}
                className="p-1 rounded hover:bg-[#333]"
                data-testid="button-cancel-create-station"
              >
                <X className="w-4 h-4 text-[#999]" />
              </button>
            </div>
            <form onSubmit={handleCreateStation} className="space-y-3">
              <div>
                <label className="block text-sm text-[#999] mb-1">Station Name *</label>
                <input
                  type="text"
                  value={newStationName}
                  onChange={(e) => setNewStationName(e.target.value)}
                  placeholder="e.g., Packing Station 1"
                  className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#333] rounded-lg text-white placeholder-[#666] focus:outline-none focus:border-primary-500"
                  data-testid="input-station-name"
                  disabled={creating}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm text-[#999] mb-1">Location (optional)</label>
                <input
                  type="text"
                  value={newStationLocation}
                  onChange={(e) => setNewStationLocation(e.target.value)}
                  placeholder="e.g., Warehouse A, Row 3"
                  className="w-full px-3 py-2 bg-[#1a1a1a] border border-[#333] rounded-lg text-white placeholder-[#666] focus:outline-none focus:border-primary-500"
                  data-testid="input-station-location"
                  disabled={creating}
                />
              </div>
              <button
                type="submit"
                disabled={creating || !newStationName.trim()}
                className="w-full py-2 bg-primary-500 hover:bg-primary-600 disabled:bg-[#333] disabled:text-[#666] rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
                data-testid="button-submit-create-station"
              >
                {creating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create Station'
                )}
              </button>
            </form>
          </div>
        )}

        {loading && stations.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-primary-500 animate-spin" />
          </div>
        ) : stations.length === 0 && !showCreateForm ? (
          <div className="text-center py-12">
            <MapPin className="w-12 h-12 text-[#444] mx-auto mb-3" />
            <p className="text-[#999]">No stations available</p>
            <p className="text-sm text-[#666] mt-1 mb-4">Create a packing station to get started</p>
            <button
              onClick={() => setShowCreateForm(true)}
              className="px-4 py-2 bg-primary-500 hover:bg-primary-600 rounded-lg font-medium transition-colors flex items-center gap-2 mx-auto"
              data-testid="button-create-first-station"
            >
              <Plus className="w-4 h-4" />
              Create Station
            </button>
          </div>
        ) : stations.length === 0 ? null : (
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
                    {station.locationHint && (
                      <p className="text-sm text-[#999] mt-1 flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {station.locationHint}
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
