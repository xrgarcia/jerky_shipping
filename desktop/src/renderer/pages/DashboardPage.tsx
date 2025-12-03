import { useState, useEffect, useRef } from 'react';
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
  ChevronRight,
  Info,
  Server,
  ChevronDown,
  RotateCcw,
  Eye,
  ExternalLink
} from 'lucide-react';
import type { AppState, PrintJob, PdfViewerInfo, PrinterLogEntry } from '@shared/types';
import logoImage from '../assets/logo.png';

interface EnvironmentInfo {
  name: string;
  label: string;
  serverUrl: string;
}

interface SystemPrinter {
  name: string;
  systemName: string;
  isDefault: boolean;
  status: string;
  suggestRawMode?: boolean; // Auto-detected suggestion for industrial printers
}

interface DashboardPageProps {
  state: AppState;
}

function DashboardPage({ state }: DashboardPageProps) {
  const [systemPrinters, setSystemPrinters] = useState<SystemPrinter[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [showPrinterSetup, setShowPrinterSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const connectionPopupRef = useRef<HTMLDivElement>(null);
  
  const [environments, setEnvironments] = useState<EnvironmentInfo[]>([]);
  const [showEnvDropdown, setShowEnvDropdown] = useState(false);
  const [switchingEnv, setSwitchingEnv] = useState(false);
  const envDropdownRef = useRef<HTMLDivElement>(null);
  
  // Job error display state
  const [expandedJobErrors, setExpandedJobErrors] = useState<Set<string>>(new Set());
  const [selectedJob, setSelectedJob] = useState<PrintJob | null>(null);
  const [retryingJob, setRetryingJob] = useState<string | null>(null);
  
  // PDF viewer detection state
  const [pdfViewerInfo, setPdfViewerInfo] = useState<PdfViewerInfo | null>(null);
  const [pdfViewerChecked, setPdfViewerChecked] = useState(false);
  
  // Printer logs state
  const [printerLogs, setPrinterLogs] = useState<PrinterLogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  
  // Use printersLoaded flag from main process to determine loading state
  const loadingPrinters = !state.printersLoaded;
  
  // React to printer state changes from main process
  useEffect(() => {
    // If we have a selected printer, hide setup
    if (state.selectedPrinter) {
      setShowPrinterSetup(false);
    }
    // If printers are loaded but none registered and none selected, show setup
    else if (state.printersLoaded && state.printers.length === 0) {
      setShowPrinterSetup(true);
    }
  }, [state.selectedPrinter, state.printers, state.printersLoaded]);

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
      
      // Check for PDF viewer when printer setup is shown
      // Clear cache and recheck each time printer setup is opened
      const checkPdfViewer = async () => {
        // Reset local state immediately so UI shows loading/fresh state
        setPdfViewerInfo(null);
        setPdfViewerChecked(false);
        
        try {
          console.log('[Dashboard] Clearing PDF viewer cache and rechecking...');
          
          // Clear cache first so we get fresh detection
          const clearResult = await window.electronAPI.printer.clearPdfViewerCache();
          if (!clearResult.success) {
            console.error('[Dashboard] Failed to clear PDF viewer cache:', clearResult.error);
            // Continue anyway, detection will use cached result
          }
          
          const result = await window.electronAPI.printer.detectPdfViewer();
          console.log('[Dashboard] PDF viewer check result:', result);
          if (result.success && result.data) {
            setPdfViewerInfo(result.data);
          } else if (!result.success) {
            console.error('[Dashboard] PDF viewer detection failed:', result.error);
          }
        } catch (err) {
          console.error('[Dashboard] Failed to detect PDF viewer:', err);
        } finally {
          setPdfViewerChecked(true);
        }
      };
      checkPdfViewer();
    }
  }, [showPrinterSetup]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (connectionPopupRef.current && !connectionPopupRef.current.contains(event.target as Node)) {
        setShowConnectionDetails(false);
      }
      if (envDropdownRef.current && !envDropdownRef.current.contains(event.target as Node)) {
        setShowEnvDropdown(false);
      }
    };
    
    if (showConnectionDetails || showEnvDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showConnectionDetails, showEnvDropdown]);

  useEffect(() => {
    const loadEnvironments = async () => {
      try {
        const result = await window.electronAPI.environment.list();
        if (result.success && result.data) {
          setEnvironments(result.data);
        }
      } catch (err) {
        console.error('Failed to load environments:', err);
      }
    };
    loadEnvironments();
  }, []);

  // Subscribe to printer logs from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI.onPrinterLog((entry: PrinterLogEntry) => {
      console.log('[Dashboard] Received printer log:', entry);
      setPrinterLogs(prev => {
        const newLogs = [entry, ...prev].slice(0, 100); // Keep last 100 logs
        return newLogs;
      });
      // Auto-scroll logs container
      if (logsContainerRef.current) {
        logsContainerRef.current.scrollTop = 0;
      }
    });
    
    return () => unsubscribe();
  }, []);

  const handleEnvChange = async (envName: string) => {
    if (envName === state.environment || switchingEnv) return;
    
    setSwitchingEnv(true);
    setShowEnvDropdown(false);
    setError(null);
    
    try {
      const result = await window.electronAPI.environment.set(envName);
      if (!result.success) {
        setError(result.error || 'Failed to switch environment');
      }
    } catch (err) {
      console.error('Failed to change environment:', err);
      setError(err instanceof Error ? err.message : 'Failed to switch environment');
    } finally {
      setSwitchingEnv(false);
    }
  };

  const handleSelectPrinter = async (printer: SystemPrinter) => {
    try {
      setError(null);
      console.log('[Renderer] handleSelectPrinter starting for:', printer.name, printer.systemName);
      
      const registerResult = await window.electronAPI.printer.register({
        name: printer.name,
        systemName: printer.systemName,
        status: printer.status, // Pass the discovered status
      });
      console.log('[Renderer] Register result:', registerResult);
      
      if (registerResult.success) {
        // Refresh the printer list to get the newly registered printer
        const listResult = await window.electronAPI.printer.list();
        console.log('[Renderer] List result:', listResult);
        
        // Find the newly registered printer in the fresh list and set it as default
        if (listResult.success && listResult.data && Array.isArray(listResult.data)) {
          console.log('[Renderer] Printers from list:', listResult.data.map((p: any) => ({ id: p.id, name: p.name, systemName: p.systemName })));
          
          // Find the printer we just registered by matching the system name
          const registeredPrinter = listResult.data.find(
            (p: { systemName: string }) => p.systemName === printer.systemName
          );
          console.log('[Renderer] Found registeredPrinter:', registeredPrinter);
          
          if (registeredPrinter) {
            console.log('[Renderer] Calling setDefault with id:', registeredPrinter.id);
            const setDefaultResult = await window.electronAPI.printer.setDefault(registeredPrinter.id);
            console.log('[Renderer] setDefault result:', setDefaultResult);
            
            if (!setDefaultResult.success) {
              setError(setDefaultResult.error || 'Failed to set default printer');
              return;
            }
          } else if (listResult.data.length > 0) {
            // Fallback: set the first printer as default if we can't find the exact match
            console.log('[Renderer] Using fallback, setting first printer as default:', listResult.data[0].id);
            const setDefaultResult = await window.electronAPI.printer.setDefault(listResult.data[0].id);
            console.log('[Renderer] Fallback setDefault result:', setDefaultResult);
            
            if (!setDefaultResult.success) {
              setError(setDefaultResult.error || 'Failed to set default printer');
              return;
            }
          } else {
            console.log('[Renderer] No printers in list to set as default');
          }
        } else {
          console.log('[Renderer] List failed or no data:', listResult);
        }
        setShowPrinterSetup(false);
        console.log('[Renderer] handleSelectPrinter completed successfully');
      } else {
        setError(registerResult.error || 'Failed to register printer');
        console.log('[Renderer] Register failed:', registerResult.error);
      }
    } catch (err) {
      console.error('[Renderer] handleSelectPrinter error:', err);
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
      case 'sent':
        return <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />;
      case 'picked_up':
        return <RefreshCw className="w-4 h-4 text-yellow-500" />;
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

  // Calculate relative time (freshness indicator)
  const getRelativeTime = (date: string): string => {
    const now = Date.now();
    const created = new Date(date).getTime();
    const diffMs = now - created;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    if (diffMins > 0) return `${diffMins}m ago`;
    if (diffSecs > 10) return `${diffSecs}s ago`;
    return 'just now';
  };

  // Refresh relative times every 30 seconds
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(interval);
  }, []);

  // Toggle expanded state for job error details
  const toggleJobError = (jobId: string) => {
    setExpandedJobErrors(prev => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  };

  // Retry a failed job
  const handleRetryJob = async (jobId: string) => {
    setRetryingJob(jobId);
    try {
      const result = await window.electronAPI.job.retry(jobId);
      if (!result.success) {
        // Show error message
        setError(result.error || 'Failed to retry print job');
        console.error('Retry failed:', result.error);
        // Auto-clear error after 5 seconds
        setTimeout(() => setError(null), 5000);
      } else {
        // Clear any previous error on success
        setError(null);
        console.log('Retry initiated successfully for job:', jobId);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to retry job';
      setError(errorMessage);
      console.error('Failed to retry job:', err);
      // Auto-clear error after 5 seconds
      setTimeout(() => setError(null), 5000);
    } finally {
      setRetryingJob(null);
    }
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

  return (
    <div className="h-full flex flex-col">
      <div className="h-12 drag-region bg-[#1a1a1a] border-b border-[#333] flex items-center justify-between px-4">
        <div className="relative" ref={connectionPopupRef}>
          <button
            onClick={() => setShowConnectionDetails(!showConnectionDetails)}
            className="flex items-center gap-2 no-drag px-2 py-1 rounded-lg hover:bg-[#333] transition-colors"
            data-testid="button-connection-status"
          >
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
            <Info className="w-3 h-3 text-[#666]" />
          </button>
          
          {showConnectionDetails && (
            <div className="absolute top-full left-0 mt-2 w-72 bg-[#242424] border border-[#444] rounded-lg shadow-xl z-50 no-drag">
              <div className="p-3 border-b border-[#333]">
                <div className="flex items-center gap-2 mb-1">
                  {state.connectionStatus === 'connected' ? (
                    <div className="w-2 h-2 bg-green-500 rounded-full" />
                  ) : state.connectionStatus === 'connecting' || state.connectionStatus === 'reconnecting' ? (
                    <div className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" />
                  ) : (
                    <div className="w-2 h-2 bg-red-500 rounded-full" />
                  )}
                  <span className="text-sm font-medium text-white">
                    {state.connectionStatus === 'connected' ? 'Connected to Server' :
                     state.connectionStatus === 'connecting' ? 'Connecting to Server...' :
                     state.connectionStatus === 'reconnecting' ? 'Reconnecting to Server...' :
                     'Disconnected from Server'}
                  </span>
                </div>
                <p className="text-xs text-[#999]">
                  {state.connectionStatus === 'connected' 
                    ? 'Real-time updates are active' 
                    : state.connectionStatus === 'reconnecting'
                    ? 'Attempting to restore connection...'
                    : 'Waiting for server connection...'}
                </p>
              </div>
              
              <div className="p-3 space-y-2 text-xs">
                {state.connectionInfo?.lastConnectedAt && (
                  <div className="flex justify-between">
                    <span className="text-[#999]">Last Connected</span>
                    <span className="text-white">
                      {new Date(state.connectionInfo.lastConnectedAt).toLocaleTimeString()}
                    </span>
                  </div>
                )}
                
                {state.connectionStatus === 'reconnecting' && state.connectionInfo?.reconnectAttempt && (
                  <div className="flex justify-between">
                    <span className="text-[#999]">Retry Attempt</span>
                    <span className="text-orange-400">
                      #{state.connectionInfo.reconnectAttempt}
                    </span>
                  </div>
                )}
                
                {state.connectionInfo?.lastError && state.connectionStatus !== 'connected' && (
                  <div className="mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-3 h-3 text-red-400 mt-0.5 flex-shrink-0" />
                      <span className="text-red-400 break-words">
                        {state.connectionInfo.lastError}
                      </span>
                    </div>
                  </div>
                )}
                
                {state.connectionStatus === 'reconnecting' && (
                  <p className="text-[#666] mt-2 pt-2 border-t border-[#333]">
                    The app will automatically reconnect when the server becomes available. No action needed.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
        <span className="text-sm font-medium text-white">{state.station?.name}</span>
        <div className="flex items-center gap-2 no-drag">
          <img 
            src={logoImage} 
            alt="Jerky.com" 
            className="h-6 object-contain"
            data-testid="img-logo"
          />
          <button
            onClick={handleLogout}
            data-testid="button-logout"
            className="p-2 rounded-lg hover:bg-[#333] transition-colors"
            title="Sign out"
          >
            <LogOut className="w-4 h-4 text-[#999]" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="p-4 border-b border-[#333]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-[#999]" />
              <span className="text-sm text-[#999]">{state.station?.locationHint || 'No location'}</span>
            </div>
            <button
              onClick={handleReleaseStation}
              data-testid="button-release-station"
              className="text-xs text-primary-500 hover:text-primary-400 transition-colors"
            >
              Change Station
            </button>
          </div>
          
          {/* Prominent Printer Status Display */}
          <div className="mb-3 p-3 rounded-lg bg-[#1c1c1c] border border-[#333]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                  state.selectedPrinter 
                    ? state.selectedPrinter.status === 'online'
                      ? 'bg-green-500/20'
                      : state.selectedPrinter.status === 'busy'
                        ? 'bg-yellow-500/20'
                        : 'bg-amber-500/20'
                    : 'bg-red-500/20'
                }`}>
                  <Printer className={`w-4 h-4 ${
                    state.selectedPrinter 
                      ? state.selectedPrinter.status === 'online'
                        ? 'text-green-500'
                        : state.selectedPrinter.status === 'busy'
                          ? 'text-yellow-500'
                          : 'text-amber-500'
                      : 'text-red-500'
                  }`} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#666]">Printer:</span>
                    <span className={`text-sm font-medium ${
                      state.selectedPrinter ? 'text-white' : 'text-red-400'
                    }`} data-testid="text-selected-printer-name">
                      {state.selectedPrinter?.name || 'NOT SELECTED'}
                    </span>
                  </div>
                  {state.selectedPrinter && (
                    <span className={`text-xs ${
                      state.selectedPrinter.status === 'online' 
                        ? 'text-green-400' 
                        : state.selectedPrinter.status === 'busy'
                          ? 'text-yellow-400'
                          : 'text-amber-400'
                    }`}>
                      {state.selectedPrinter.status === 'online' ? 'Ready' : 
                       state.selectedPrinter.status === 'busy' ? 'Busy' : 'Offline'}
                    </span>
                  )}
                </div>
              </div>
              {!state.selectedPrinter && (
                <button
                  onClick={() => setShowPrinterSetup(true)}
                  data-testid="button-setup-printer-quick"
                  className="text-xs px-2 py-1 rounded bg-primary-500 hover:bg-primary-600 text-white transition-colors"
                >
                  Set Up
                </button>
              )}
            </div>
          </div>
          
          <div className="relative mb-3" ref={envDropdownRef}>
            <button
              onClick={() => setShowEnvDropdown(!showEnvDropdown)}
              disabled={switchingEnv}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border transition-colors ${
                state.environment === 'development'
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                  : 'bg-[#2a2a2a] border-[#444] text-white'
              } ${switchingEnv ? 'opacity-50' : ''}`}
              data-testid="button-env-selector"
            >
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4" />
                <span className="text-sm font-medium">
                  {switchingEnv ? 'Switching...' : environments.find(e => e.name === state.environment)?.label || state.environment}
                </span>
              </div>
              {switchingEnv ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <ChevronDown className={`w-4 h-4 transition-transform ${showEnvDropdown ? 'rotate-180' : ''}`} />
              )}
            </button>
            
            {showEnvDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-[#2a2a2a] border border-[#444] rounded-lg overflow-hidden z-10 shadow-xl">
                {environments.map((env) => (
                  <button
                    key={env.name}
                    onClick={() => handleEnvChange(env.name)}
                    className={`w-full px-3 py-2 text-left transition-colors flex flex-col ${
                      env.name === state.environment
                        ? 'bg-primary-500/20 text-white'
                        : 'text-[#ccc] hover:bg-[#333]'
                    }`}
                    data-testid={`button-env-${env.name}`}
                  >
                    <span className="text-sm font-medium">{env.label}</span>
                    <span className="text-xs text-[#888] truncate">{env.serverUrl}</span>
                  </button>
                ))}
              </div>
            )}
            
            {error && !showPrinterSetup && (
              <div className="mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-xs">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              </div>
            )}
          </div>

          {loadingPrinters ? (
            <div className="w-full p-4 rounded-xl bg-[#242424] border border-[#333] flex items-center justify-center gap-2">
              <RefreshCw className="w-4 h-4 text-[#999] animate-spin" />
              <span className="text-sm text-[#999]">Loading printer...</span>
            </div>
          ) : showPrinterSetup ? (
            <div className="bg-[#242424] rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium text-white">Select Printer</h3>
                <div className="flex items-center gap-2">
                  {state.selectedPrinter && (
                    <button
                      onClick={() => setShowPrinterSetup(false)}
                      data-testid="button-cancel-printer-selection"
                      className="text-xs text-[#999] hover:text-white px-2 py-1 rounded hover:bg-[#333] transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={discoverPrinters}
                    disabled={discovering}
                    data-testid="button-refresh-printers"
                    className="p-1.5 rounded hover:bg-[#333] transition-colors"
                  >
                    <RefreshCw className={`w-4 h-4 text-[#999] ${discovering ? 'animate-spin' : ''}`} />
                  </button>
                </div>
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
                  {systemPrinters.map((printer) => {
                    const isOnline = printer.status === 'online';
                    const isBusy = printer.status === 'busy';
                    const isOffline = printer.status === 'offline' || (!isOnline && !isBusy);
                    
                    return (
                      <button
                        key={printer.systemName}
                        onClick={() => handleSelectPrinter(printer)}
                        data-testid={`button-select-printer-${printer.systemName}`}
                        className={`w-full p-3 rounded-lg bg-[#1a1a1a] hover:bg-[#2a2a2a] border transition-all flex items-center justify-between text-left ${
                          isOffline 
                            ? 'border-amber-500/30 hover:border-amber-500/50' 
                            : 'border-[#333] hover:border-primary-500/50'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                            isOnline 
                              ? 'bg-green-500/20' 
                              : isBusy 
                                ? 'bg-yellow-500/20'
                                : 'bg-amber-500/20'
                          }`}>
                            <Printer className={`w-5 h-5 ${
                              isOnline 
                                ? 'text-green-500' 
                                : isBusy 
                                  ? 'text-yellow-500'
                                  : 'text-amber-500'
                            }`} />
                          </div>
                          <div>
                            <p className="text-sm text-white">{printer.name}</p>
                            <div className="flex items-center gap-2">
                              <span className={`inline-flex items-center gap-1 text-xs ${
                                isOnline 
                                  ? 'text-green-400' 
                                  : isBusy 
                                    ? 'text-yellow-400'
                                    : 'text-amber-400'
                              }`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${
                                  isOnline 
                                    ? 'bg-green-500' 
                                    : isBusy 
                                      ? 'bg-yellow-500'
                                      : 'bg-amber-500'
                                }`} />
                                {isOnline ? 'Ready' : isBusy ? 'Busy' : 'Offline'}
                              </span>
                              {isOffline && (
                                <span className="text-xs text-[#666]">(jobs will queue)</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {printer.suggestRawMode && (
                            <span 
                              className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400"
                              title="Industrial printer detected - will use direct printing mode"
                            >
                              Industrial
                            </span>
                          )}
                          {printer.isDefault && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-primary-500/20 text-primary-400">
                              Default
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              
              {/* PDF Viewer status - only show on Windows */}
              {pdfViewerChecked && (
                pdfViewerInfo?.installed ? (
                  <div className="mt-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                    <div className="flex items-start gap-2">
                      <Check className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
                      <div className="text-xs text-green-300">
                        <p className="font-medium">PDF Viewer: {pdfViewerInfo.viewer}</p>
                        {pdfViewerInfo.path && (
                          <p className="text-green-300/60 text-[10px] mt-0.5 truncate" title={pdfViewerInfo.path}>
                            {pdfViewerInfo.path}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                      <div className="text-xs text-amber-300">
                        <p className="font-medium mb-1">PDF Viewer Required</p>
                        <p className="text-amber-300/80 mb-2">
                          To print shipping labels, you need a PDF viewer installed. We recommend SumatraPDF for best compatibility with label printers.
                        </p>
                        <a 
                          href="https://www.sumatrapdfreader.org/download-free-pdf-viewer"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-amber-400 hover:text-amber-300 underline"
                          data-testid="link-download-sumatra"
                        >
                          Download SumatraPDF (free)
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>
          ) : state.selectedPrinter ? (
            (() => {
              const isOnline = state.selectedPrinter.status === 'online';
              const isBusy = state.selectedPrinter.status === 'busy';
              const isOffline = !isOnline && !isBusy;
              
              return (
                <button
                  onClick={() => setShowPrinterSetup(true)}
                  data-testid="button-change-printer"
                  className={`w-full p-3 rounded-xl bg-[#242424] hover:bg-[#2a2a2a] border transition-all flex items-center justify-between ${
                    isOffline ? 'border-amber-500/30' : 'border-[#333]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      isOnline 
                        ? 'bg-green-500/20' 
                        : isBusy 
                          ? 'bg-yellow-500/20'
                          : 'bg-amber-500/20'
                    }`}>
                      <Printer className={`w-5 h-5 ${
                        isOnline 
                          ? 'text-green-500' 
                          : isBusy 
                            ? 'text-yellow-500'
                            : 'text-amber-500'
                      }`} />
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-medium text-white">{state.selectedPrinter.name}</p>
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center gap-1 text-xs ${
                          isOnline 
                            ? 'text-green-400' 
                            : isBusy 
                              ? 'text-yellow-400'
                              : 'text-amber-400'
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            isOnline 
                              ? 'bg-green-500' 
                              : isBusy 
                                ? 'bg-yellow-500'
                                : 'bg-amber-500'
                          }`} />
                          {isOnline ? 'Ready to print' : isBusy ? 'Busy' : 'Offline'}
                        </span>
                        {isOffline && (
                          <span className="text-xs text-[#666]">(jobs will queue)</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-[#666]" />
                </button>
              );
            })()
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
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowLogs(!showLogs)}
                data-testid="button-toggle-logs"
                className={`text-xs px-2 py-1 rounded flex items-center gap-1 transition-colors ${
                  showLogs 
                    ? 'bg-primary-500/20 text-primary-400' 
                    : 'bg-[#333] text-[#888] hover:text-white'
                }`}
              >
                <Eye className="w-3 h-3" />
                Logs {printerLogs.length > 0 && `(${printerLogs.length})`}
              </button>
              <span className="text-xs text-[#666]">{state.printJobs.length} jobs</span>
            </div>
          </div>
          
          {/* Printer Logs Panel */}
          {showLogs && (
            <div className="mb-4 rounded-lg bg-[#1a1a1a] border border-[#333] overflow-hidden">
              <div className="px-3 py-2 border-b border-[#333] flex items-center justify-between">
                <span className="text-xs font-medium text-white">Print Diagnostics</span>
                <button
                  onClick={() => setPrinterLogs([])}
                  className="text-xs text-[#666] hover:text-white transition-colors"
                  data-testid="button-clear-logs"
                >
                  Clear
                </button>
              </div>
              <div 
                ref={logsContainerRef}
                className="max-h-48 overflow-y-auto p-2 space-y-1 font-mono text-xs"
              >
                {printerLogs.length === 0 ? (
                  <div className="text-[#666] text-center py-4">
                    No logs yet. Logs will appear when print jobs are processed.
                  </div>
                ) : (
                  printerLogs.map((log, i) => (
                    <div 
                      key={`${log.timestamp}-${i}`}
                      className={`px-2 py-1 rounded ${
                        log.level === 'error' ? 'bg-red-500/10 text-red-400' :
                        log.level === 'warn' ? 'bg-yellow-500/10 text-yellow-400' :
                        log.stage === 'JOB_RECEIVED' ? 'bg-blue-500/10 text-blue-400' :
                        log.stage === 'RESULT' ? (log.details?.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400') :
                        'bg-[#242424] text-[#999]'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-[#666] whitespace-nowrap">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                        <span className={`px-1 rounded text-[10px] ${
                          log.stage === 'JOB_RECEIVED' ? 'bg-blue-500/30' :
                          log.stage === 'LABEL_DOWNLOAD' ? 'bg-purple-500/30' :
                          log.stage === 'COMMAND_INVOKED' ? 'bg-yellow-500/30' :
                          log.stage === 'RESULT' ? 'bg-green-500/30' :
                          'bg-[#333]'
                        }`}>
                          {log.stage}
                        </span>
                        <span className="flex-1 break-all">{log.message}</span>
                      </div>
                      {log.orderNumber && (
                        <div className="ml-16 text-[#666]">Order: {log.orderNumber}</div>
                      )}
                      {log.details && log.stage === 'COMMAND_INVOKED' && log.details.fullCommand && (
                        <div className="ml-16 text-[10px] text-[#888] break-all mt-1">
                          Command: {String(log.details.fullCommand)}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
          
          {/* Retry error display */}
          {error && (
            <div className="mb-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-red-400 font-medium">Retry Failed</p>
                <p className="text-xs text-red-400/80">{error}</p>
              </div>
              <button
                onClick={() => setError(null)}
                className="text-red-400/60 hover:text-red-400 transition-colors"
                data-testid="button-dismiss-error"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

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
                        <div className="flex items-center gap-2">
                          <p className="text-sm text-white font-medium">{job.orderNumber || 'Unknown Order'}</p>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                            job.status === 'pending' || job.status === 'queued' 
                              ? 'bg-blue-500/20 text-blue-400' 
                              : 'bg-[#333] text-[#888]'
                          }`}>
                            {getRelativeTime(job.createdAt)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-[#666]">
                          <span>{formatTime(job.createdAt)}</span>
                          {job.requestedBy && (
                            <>
                              <span>•</span>
                              <span>{job.requestedBy}</span>
                            </>
                          )}
                        </div>
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
                  {job.status === 'failed' && (
                    <div className="mt-2">
                      {/* Clickable error indicator */}
                      <button
                        onClick={() => toggleJobError(job.id)}
                        data-testid={`button-toggle-error-${job.id}`}
                        className="w-full p-2 rounded bg-red-500/10 hover:bg-red-500/20 transition-colors flex items-center justify-between gap-2 cursor-pointer"
                      >
                        <div className="flex items-center gap-2">
                          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                          <span className="text-xs text-red-400 font-medium">Print Failed</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-red-400/60">
                            {expandedJobErrors.has(job.id) ? 'Hide details' : 'Show details'}
                          </span>
                          <ChevronDown 
                            className={`w-3 h-3 text-red-400 transition-transform ${
                              expandedJobErrors.has(job.id) ? 'rotate-180' : ''
                            }`} 
                          />
                        </div>
                      </button>
                      
                      {/* Expanded error details */}
                      {expandedJobErrors.has(job.id) && (
                        <div className="mt-2 p-3 rounded bg-red-500/5 border border-red-500/20">
                          <div className="text-xs text-[#999] mb-1">Error Message:</div>
                          <p className="text-sm text-red-400 mb-3 font-mono bg-[#1a1a1a] p-2 rounded">
                            {job.errorMessage || 'Unknown error occurred'}
                          </p>
                          
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleRetryJob(job.id)}
                              disabled={retryingJob === job.id}
                              data-testid={`button-retry-job-${job.id}`}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
                            >
                              <RotateCcw className={`w-3 h-3 ${retryingJob === job.id ? 'animate-spin' : ''}`} />
                              {retryingJob === job.id ? 'Retrying...' : 'Retry Print'}
                            </button>
                            <button
                              onClick={() => setSelectedJob(job)}
                              data-testid={`button-view-job-${job.id}`}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#333] hover:bg-[#444] text-white text-xs font-medium transition-colors"
                            >
                              <Eye className="w-3 h-3" />
                              View Details
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Job Details Modal */}
      {selectedJob && (
        <div 
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedJob(null)}
        >
          <div 
            className="bg-[#1c1c1c] rounded-xl border border-[#333] max-w-md w-full max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-[#333] flex items-center justify-between">
              <div className="flex items-center gap-3">
                {getStatusIcon(selectedJob.status)}
                <div>
                  <h3 className="font-medium text-white">Print Job Details</h3>
                  <p className="text-xs text-[#666]">{selectedJob.orderNumber || 'Unknown Order'}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedJob(null)}
                data-testid="button-close-job-modal"
                className="p-1 rounded hover:bg-[#333] transition-colors"
              >
                <X className="w-5 h-5 text-[#666]" />
              </button>
            </div>
            
            <div className="p-4 space-y-4">
              {/* Job ID */}
              <div>
                <div className="text-xs text-[#666] mb-1">Job ID</div>
                <p className="text-sm text-white font-mono bg-[#242424] p-2 rounded break-all">
                  {selectedJob.id}
                </p>
              </div>
              
              {/* Status */}
              <div>
                <div className="text-xs text-[#666] mb-1">Status</div>
                <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium ${
                  selectedJob.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                  selectedJob.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                  selectedJob.status === 'sent' ? 'bg-blue-500/20 text-blue-400' :
                  selectedJob.status === 'picked_up' ? 'bg-yellow-500/20 text-yellow-400' :
                  'bg-[#333] text-[#999]'
                }`}>
                  {getStatusIcon(selectedJob.status)}
                  {selectedJob.status}
                </span>
              </div>
              
              {/* Error Message (if failed) */}
              {selectedJob.status === 'failed' && selectedJob.errorMessage && (
                <div>
                  <div className="text-xs text-[#666] mb-1">Error Message</div>
                  <div className="p-3 rounded bg-red-500/10 border border-red-500/20">
                    <p className="text-sm text-red-400 font-mono break-words">
                      {selectedJob.errorMessage}
                    </p>
                  </div>
                </div>
              )}
              
              {/* Timestamps */}
              <div>
                <div className="text-xs text-[#666] mb-1">Created</div>
                <p className="text-sm text-white">
                  {new Date(selectedJob.createdAt).toLocaleString()}
                </p>
              </div>
              
              {selectedJob.printedAt && (
                <div>
                  <div className="text-xs text-[#666] mb-1">Completed</div>
                  <p className="text-sm text-white">
                    {new Date(selectedJob.printedAt).toLocaleString()}
                  </p>
                </div>
              )}
              
              {/* Requested By */}
              {selectedJob.requestedBy && (
                <div>
                  <div className="text-xs text-[#666] mb-1">Requested By</div>
                  <p className="text-sm text-white">{selectedJob.requestedBy}</p>
                </div>
              )}
              
              {/* Label URL */}
              {selectedJob.labelUrl && (
                <div>
                  <div className="text-xs text-[#666] mb-1">Label URL</div>
                  <p className="text-xs text-[#888] font-mono bg-[#242424] p-2 rounded break-all">
                    {selectedJob.labelUrl}
                  </p>
                </div>
              )}
            </div>
            
            {/* Actions */}
            {selectedJob.status === 'failed' && (
              <div className="p-4 border-t border-[#333]">
                <button
                  onClick={() => {
                    handleRetryJob(selectedJob.id);
                    setSelectedJob(null);
                  }}
                  disabled={retryingJob === selectedJob.id}
                  data-testid="button-retry-job-modal"
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary-500 hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium transition-colors"
                >
                  <RotateCcw className={`w-4 h-4 ${retryingJob === selectedJob.id ? 'animate-spin' : ''}`} />
                  {retryingJob === selectedJob.id ? 'Retrying...' : 'Retry Print Job'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default DashboardPage;
