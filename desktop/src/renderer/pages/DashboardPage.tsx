import { useState, useEffect } from 'react';
import { 
  Printer, 
  Wifi, 
  WifiOff, 
  LogOut, 
  MapPin, 
  RefreshCw,
  Check,
  X,
  Clock,
  AlertCircle,
  ChevronRight
} from 'lucide-react';
import type { AppState, PrintJob } from '@shared/types';

interface SystemPrinter {
  name: string;
  systemName: string;
  isDefault: boolean;
  status: string;
}

interface DashboardPageProps {
  state: AppState;
}

function DashboardPage({ state }: DashboardPageProps) {
  const [systemPrinters, setSystemPrinters] = useState<SystemPrinter[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [showPrinterSetup, setShowPrinterSetup] = useState(!state.selectedPrinter);
  const [error, setError] = useState<string | null>(null);

  const discoverPrinters = async () => {
    setDiscovering(true);
    setError(null);
    
    try {
      const result = await window.electronAPI.printer.discover();
      if (result.success && result.data) {
        setSystemPrinters(result.data as SystemPrinter[]);
      } else {
        setError(result.error || 'Failed to discover printers');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discover printers');
    } finally {
      setDiscovering(false);
    }
  };

  useEffect(() => {
    if (showPrinterSetup) {
      discoverPrinters();
    }
  }, [showPrinterSetup]);

  const handleSelectPrinter = async (printer: SystemPrinter) => {
    try {
      const registerResult = await window.electronAPI.printer.register({
        name: printer.name,
        systemName: printer.systemName,
      });
      
      if (registerResult.success) {
        await window.electronAPI.printer.list();
        
        if (state.printers.length > 0) {
          await window.electronAPI.printer.setDefault(state.printers[0].id);
        }
        setShowPrinterSetup(false);
      } else {
        setError(registerResult.error || 'Failed to register printer');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select printer');
    }
  };

  const handleReleaseStation = async () => {
    await window.electronAPI.station.release();
  };

  const handleLogout = async () => {
    await window.electronAPI.auth.logout();
  };

  const getStatusIcon = (status: PrintJob['status']) => {
    switch (status) {
      case 'completed':
        return <Check className="w-4 h-4 text-green-500" />;
      case 'failed':
        return <X className="w-4 h-4 text-red-500" />;
      case 'printing':
        return <RefreshCw className="w-4 h-4 text-primary-500 animate-spin" />;
      case 'queued':
      case 'pending':
      default:
        return <Clock className="w-4 h-4 text-[#999]" />;
    }
  };

  const formatTime = (date: string) => {
    return new Date(date).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  const getConnectionStatusText = () => {
    const info = state.connectionInfo;
    switch (state.connectionStatus) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Connecting...';
      case 'reconnecting':
        return `Retrying (${info?.reconnectAttempt || 0})...`;
      case 'disconnected':
        return 'Disconnected';
      default:
        return 'Unknown';
    }
  };

  const getConnectionTooltip = () => {
    const info = state.connectionInfo;
    if (state.connectionStatus === 'connected' && info?.lastConnectedAt) {
      const connectedAt = new Date(info.lastConnectedAt);
      return `Connected since ${connectedAt.toLocaleTimeString()}`;
    }
    if (state.connectionStatus === 'reconnecting' && info?.lastError) {
      return `Last error: ${info.lastError}\nRetry attempt ${info.reconnectAttempt}`;
    }
    if (state.connectionStatus === 'disconnected' && info?.lastError) {
      return `Error: ${info.lastError}`;
    }
    return state.connectionStatus;
  };

  return (
    <div className="h-full flex flex-col">
      <div className="h-12 drag-region bg-[#1a1a1a] border-b border-[#333] flex items-center justify-between px-4">
        <div className="flex items-center gap-2 no-drag" title={getConnectionTooltip()}>
          {state.connectionStatus === 'connected' ? (
            <div className="relative">
              <Wifi className="w-4 h-4 text-green-500" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-500 rounded-full" />
            </div>
          ) : state.connectionStatus === 'connecting' ? (
            <Wifi className="w-4 h-4 text-yellow-500 animate-pulse" />
          ) : state.connectionStatus === 'reconnecting' ? (
            <div className="relative">
              <Wifi className="w-4 h-4 text-orange-500 animate-pulse" />
              <RefreshCw className="absolute -bottom-1 -right-1 w-2.5 h-2.5 text-orange-500 animate-spin" />
            </div>
          ) : (
            <WifiOff className="w-4 h-4 text-red-500" />
          )}
          <span className={`text-xs ${
            state.connectionStatus === 'connected' ? 'text-green-500' :
            state.connectionStatus === 'reconnecting' ? 'text-orange-400' :
            state.connectionStatus === 'connecting' ? 'text-yellow-500' :
            'text-red-400'
          }`}>
            {getConnectionStatusText()}
          </span>
        </div>
        <span className="text-sm font-medium text-white">{state.station?.name}</span>
        <button
          onClick={handleLogout}
          data-testid="button-logout"
          className="p-2 rounded-lg hover:bg-[#333] transition-colors no-drag"
          title="Sign out"
        >
          <LogOut className="w-4 h-4 text-[#999]" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="p-4 border-b border-[#333]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-[#999]" />
              <span className="text-sm text-[#999]">{state.station?.location || 'No location'}</span>
            </div>
            <button
              onClick={handleReleaseStation}
              data-testid="button-release-station"
              className="text-xs text-primary-500 hover:text-primary-400 transition-colors"
            >
              Change Station
            </button>
          </div>

          {showPrinterSetup ? (
            <div className="bg-[#242424] rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium text-white">Select Printer</h3>
                <button
                  onClick={discoverPrinters}
                  disabled={discovering}
                  data-testid="button-refresh-printers"
                  className="p-1.5 rounded hover:bg-[#333] transition-colors"
                >
                  <RefreshCw className={`w-4 h-4 text-[#999] ${discovering ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {error && (
                <div className="mb-3 p-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-xs">
                  {error}
                </div>
              )}

              {systemPrinters.length === 0 && !discovering ? (
                <p className="text-sm text-[#999] text-center py-4">
                  No printers found. Make sure printers are connected.
                </p>
              ) : (
                <div className="space-y-2">
                  {systemPrinters.map((printer) => (
                    <button
                      key={printer.systemName}
                      onClick={() => handleSelectPrinter(printer)}
                      data-testid={`button-select-printer-${printer.systemName}`}
                      className="w-full p-3 rounded-lg bg-[#1a1a1a] hover:bg-[#2a2a2a] border border-[#333] hover:border-primary-500/50 transition-all flex items-center justify-between text-left"
                    >
                      <div className="flex items-center gap-3">
                        <Printer className="w-5 h-5 text-[#999]" />
                        <div>
                          <p className="text-sm text-white">{printer.name}</p>
                          <p className="text-xs text-[#666]">{printer.status}</p>
                        </div>
                      </div>
                      {printer.isDefault && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-primary-500/20 text-primary-400">
                          Default
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : state.selectedPrinter ? (
            <button
              onClick={() => setShowPrinterSetup(true)}
              data-testid="button-change-printer"
              className="w-full p-3 rounded-xl bg-[#242424] hover:bg-[#2a2a2a] border border-[#333] transition-all flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary-500/20 flex items-center justify-center">
                  <Printer className="w-5 h-5 text-primary-500" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-white">{state.selectedPrinter.name}</p>
                  <p className="text-xs text-[#999]">
                    {state.selectedPrinter.status === 'online' ? 'Ready to print' : state.selectedPrinter.status}
                  </p>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-[#666]" />
            </button>
          ) : (
            <button
              onClick={() => setShowPrinterSetup(true)}
              data-testid="button-setup-printer"
              className="w-full p-4 rounded-xl border-2 border-dashed border-[#333] hover:border-primary-500/50 transition-colors flex items-center justify-center gap-2 text-[#999] hover:text-primary-400"
            >
              <Printer className="w-5 h-5" />
              <span>Set up printer</span>
            </button>
          )}
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-medium text-white">Recent Print Jobs</h3>
            <span className="text-xs text-[#666]">{state.printJobs.length} jobs</span>
          </div>

          {state.printJobs.length === 0 ? (
            <div className="text-center py-8">
              <Clock className="w-10 h-10 text-[#444] mx-auto mb-2" />
              <p className="text-[#999] text-sm">No print jobs yet</p>
              <p className="text-[#666] text-xs mt-1">Jobs will appear here when sent from the web app</p>
            </div>
          ) : (
            <div className="space-y-2">
              {state.printJobs.slice(0, 20).map((job) => (
                <div
                  key={job.id}
                  data-testid={`print-job-${job.id}`}
                  className="p-3 rounded-lg bg-[#242424] border border-[#333]"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {getStatusIcon(job.status)}
                      <div>
                        <p className="text-sm text-white">{job.orderNumber}</p>
                        <p className="text-xs text-[#666]">{formatTime(job.createdAt)}</p>
                      </div>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      job.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                      job.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                      job.status === 'printing' ? 'bg-primary-500/20 text-primary-400' :
                      'bg-[#333] text-[#999]'
                    }`}>
                      {job.status}
                    </span>
                  </div>
                  {job.status === 'failed' && job.errorMessage && (
                    <div className="mt-2 p-2 rounded bg-red-500/10 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-red-400">{job.errorMessage}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default DashboardPage;
