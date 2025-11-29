import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, Menu } from 'electron';
import path from 'path';
import { AuthService } from './auth';
import { WebSocketClient } from './websocket';
import { PrinterService } from './printer';
import { ApiClient } from './api';
import { AppState, PrintJob, ConnectionInfo } from '../shared/types';
import { environments, config, getEnvironment, fetchRemoteConfig, runtimeConfig } from '../shared/config';

// Global error handlers to prevent crashes during server restarts
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error.message);
  
  // Don't crash for expected network errors (server restart, connection refused, etc.)
  const isNetworkError = error.message.includes('502') ||
                         error.message.includes('503') ||
                         error.message.includes('ECONNREFUSED') ||
                         error.message.includes('ETIMEDOUT') ||
                         error.message.includes('Unexpected server response') ||
                         error.message.includes('WebSocket');
  
  if (!isNetworkError) {
    // For unexpected errors, log but don't show dialog (it's annoying)
    console.error('[Main] Unexpected error (non-network):', error);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Main] Unhandled rejection:', reason);
  // Don't crash - just log it
});

let mainWindow: BrowserWindow | null = null;
let authService: AuthService;
let wsClient: WebSocketClient | null = null;
let printerService: PrinterService;
let apiClient: ApiClient | null = null;

let selectedEnvironment = config.defaultEnvironment;

const initialConnectionInfo: ConnectionInfo = {
  status: 'disconnected',
  reconnectAttempt: 0,
  lastError: null,
  lastConnectedAt: null,
};

let appState: AppState = {
  auth: {
    isAuthenticated: false,
    user: null,
    token: null,
    clientId: null,
  },
  station: null,
  session: null,
  printers: [],
  selectedPrinter: null,
  printersLoaded: false,
  printJobs: [],
  connectionStatus: 'disconnected',
  connectionInfo: { ...initialConnectionInfo },
  environment: selectedEnvironment,
};

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  
  const preloadPath = process.env.NODE_ENV === 'development'
    ? path.join(__dirname, 'preload.js')
    : path.join(app.getAppPath(), 'dist', 'main', 'main', 'preload.js');
  
  // Load the app icon
  const iconPath = process.env.NODE_ENV === 'development'
    ? path.join(__dirname, '..', 'renderer', 'assets', 'logo.png')
    : path.join(app.getAppPath(), 'dist', 'renderer', 'assets', 'logo.png');
  
  let appIcon: Electron.NativeImage | undefined;
  try {
    appIcon = nativeImage.createFromPath(iconPath);
    if (appIcon.isEmpty()) {
      console.warn('[Main] App icon not found at:', iconPath);
      appIcon = undefined;
    }
  } catch (error) {
    console.warn('[Main] Failed to load app icon:', error);
  }
  
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 480,
    height: 720,
    minWidth: 400,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
    show: false,
    backgroundColor: '#1a1a1a',
    icon: appIcon,
  };
  
  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 16, y: 16 };
  } else if (isWin) {
    windowOptions.frame = true;
    windowOptions.autoHideMenuBar = true;
  }
  
  mainWindow = new BrowserWindow(windowOptions);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const appPath = app.getAppPath();
    const rendererPath = path.join(appPath, 'dist', 'renderer', 'index.html');
    mainWindow.loadFile(rendererPath);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function broadcastState(): void {
  mainWindow?.webContents.send('app:state-changed', appState);
}

function updateState(updates: Partial<AppState>): void {
  appState = { ...appState, ...updates };
  broadcastState();
}

// Safe job state update - directly mutates state synchronously
// JavaScript is single-threaded, so this is atomic between await boundaries
// Clears errorMessage when transitioning to non-failed statuses to prevent stale diagnostics
function safeUpdateJob(jobId: string, status: PrintJob['status'], errorMessage?: string): void {
  const updatedJobs = appState.printJobs.map(j => {
    if (j.id !== jobId) return j;
    const updated: PrintJob = { ...j, status };
    // Set errorMessage explicitly: use provided value, or clear it if transitioning to non-failed status
    if (errorMessage !== undefined) {
      updated.errorMessage = errorMessage;
    } else if (status !== 'failed') {
      // Clear any prior error when transitioning to a non-failed status
      updated.errorMessage = undefined;
    }
    return updated;
  });
  appState = { ...appState, printJobs: updatedJobs };
  broadcastState();
}

// Safe job add - directly mutates state synchronously
// Deduplicates by returning 'exists' if job ID already exists
// Returns { added: true } if job was added, or { added: false, existingJob } if duplicate
function safeAddJob(job: PrintJob): { added: true } | { added: false; existingJob: PrintJob } {
  const existingJob = appState.printJobs.find(j => j.id === job.id);
  if (existingJob) {
    console.log(`[Main] Job ${job.id} already exists with status: ${existingJob.status}`);
    return { added: false, existingJob };
  }
  appState = { ...appState, printJobs: [job, ...appState.printJobs] };
  broadcastState();
  return { added: true };
}

// Safe bulk job add - atomically checks and adds only new jobs
// Returns { newJobs: jobs that were added, duplicates: existing jobs that match incoming IDs }
function safeAddBatchJobs(jobs: PrintJob[]): { newJobs: PrintJob[]; duplicates: PrintJob[] } {
  const currentJobsById = new Map(appState.printJobs.map(j => [j.id, j]));
  const newJobs: PrintJob[] = [];
  const duplicates: PrintJob[] = [];
  
  for (const job of jobs) {
    const existing = currentJobsById.get(job.id);
    if (existing) {
      duplicates.push(existing);
    } else {
      newJobs.push(job);
    }
  }
  
  if (newJobs.length > 0) {
    appState = { ...appState, printJobs: [...newJobs, ...appState.printJobs] };
    broadcastState();
  }
  
  return { newJobs, duplicates };
}

// Get current WebSocket client - must be called to get fresh reference after awaits
function getCurrentWsClient(): typeof wsClient {
  return wsClient;
}

// Get current state for read operations - must be called synchronously before any await
function getState(): AppState {
  return appState;
}

// Pending status updates queue - for updates that couldn't be sent due to ws unavailability
// IMPORTANT: We keep ALL transitions per job (in order) so server receives the full lifecycle
// The server needs to see: pending → picked_up → sent → completed/failed
interface PendingStatusUpdate {
  jobId: string;
  status: PrintJob['status'];
  errorMessage?: string;
  timestamp: number;
  sequence: number; // Order within job's lifecycle
}
const pendingStatusUpdates: PendingStatusUpdate[] = [];
const jobSequenceCounters = new Map<string, number>(); // Track sequence per job

// Queue a status update for retry if ws is unavailable
// KEEPS ALL TRANSITIONS - does not collapse to latest
function queueStatusUpdate(jobId: string, status: PrintJob['status'], errorMessage?: string): void {
  // Get next sequence number for this job
  const currentSeq = jobSequenceCounters.get(jobId) ?? 0;
  const nextSeq = currentSeq + 1;
  jobSequenceCounters.set(jobId, nextSeq);
  
  pendingStatusUpdates.push({ 
    jobId, 
    status, 
    errorMessage, 
    timestamp: Date.now(),
    sequence: nextSeq
  });
  console.log(`[Main] Queued status update for job ${jobId}: ${status} (seq ${nextSeq}, ${pendingStatusUpdates.length} total pending)`);
}

// Try to send a status update, queue if fails
// Does NOT remove from queue - only flushPendingStatusUpdates removes after successful send
function trySendStatusUpdate(ws: typeof wsClient, jobId: string, status: PrintJob['status'], errorMessage?: string): boolean {
  if (ws) {
    try {
      ws.sendJobUpdate(jobId, status, errorMessage);
      return true;
    } catch (e) {
      console.error(`[Main] Failed to send status update for job ${jobId}:`, e);
      queueStatusUpdate(jobId, status, errorMessage);
      return false;
    }
  } else {
    queueStatusUpdate(jobId, status, errorMessage);
    return false;
  }
}

// Flush pending updates on reconnect - sends ALL transitions in order
function flushPendingStatusUpdates(): void {
  const ws = getCurrentWsClient();
  if (!ws || pendingStatusUpdates.length === 0) return;
  
  console.log(`[Main] Flushing ${pendingStatusUpdates.length} pending status update(s)`);
  
  // Sort by timestamp then sequence to ensure correct order
  const sortedUpdates = [...pendingStatusUpdates].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.sequence - b.sequence;
  });
  
  // Clear the queue - we'll re-add failed ones
  pendingStatusUpdates.length = 0;
  
  const failed: PendingStatusUpdate[] = [];
  
  for (const update of sortedUpdates) {
    try {
      ws.sendJobUpdate(update.jobId, update.status, update.errorMessage);
      console.log(`[Main] Flushed status update for job ${update.jobId}: ${update.status} (seq ${update.sequence})`);
    } catch (e) {
      // Re-queue if send fails
      failed.push(update);
      console.error(`[Main] Failed to flush status update for job ${update.jobId}:`, e);
    }
  }
  
  // Re-add any failed updates
  if (failed.length > 0) {
    pendingStatusUpdates.push(...failed);
    console.log(`[Main] ${failed.length} update(s) re-queued after flush failure`);
  }
  
  // Clear sequence counters for jobs that were fully flushed
  for (const [jobId] of jobSequenceCounters) {
    if (!pendingStatusUpdates.some(u => u.jobId === jobId)) {
      jobSequenceCounters.delete(jobId);
    }
  }
}

async function initializeApp(): Promise<void> {
  authService = new AuthService();
  printerService = new PrinterService();
  
  selectedEnvironment = await loadEnvironmentSetting();
  updateState({ environment: selectedEnvironment });
  
  const savedAuth = await authService.loadSavedAuth();
  if (savedAuth) {
    const expectedServerUrl = getEnvironment(selectedEnvironment).serverUrl;
    
    if (savedAuth.serverUrl !== expectedServerUrl) {
      console.log('[Init] Saved auth serverUrl differs from selected environment, clearing auth');
      await authService.clearAuth();
      // No station session, mark printers as loaded (empty state)
      updateState({ printersLoaded: true });
    } else {
      if (savedAuth.environment) {
        selectedEnvironment = savedAuth.environment;
        updateState({ environment: selectedEnvironment });
      }
      
      apiClient = new ApiClient(savedAuth.token, savedAuth.serverUrl);
      
      try {
        const user = await apiClient.getCurrentUser();
        updateState({
          auth: {
            isAuthenticated: true,
            user,
            token: savedAuth.token,
            clientId: savedAuth.clientId,
          },
        });
        
        await connectWebSocket();
        
        // Try to restore an existing active session from the server
        if (apiClient) {
          try {
            console.log('[Init] Checking for existing session...');
            const currentSession = await apiClient.getCurrentSession();
            
            if (currentSession) {
              const { session, station } = currentSession;
              console.log('[Init] Found existing session for station:', station.name);
              
              updateState({ station, session });
              
              // Update saved stationId if different
              if (savedAuth.stationId !== station.id) {
                await authService.updateStationId(station.id);
              }
              
              if (wsClient) {
                wsClient.subscribeToStation(station.id);
              }
              
              // Fetch printers for restored station
              try {
                const printers = await apiClient.getPrinters(station.id);
                const selectedPrinter = printers.length > 0 
                  ? (printers.find(p => p.isDefault) || printers[0])
                  : null;
                updateState({ printers, selectedPrinter, printersLoaded: true });
                console.log('[Init] Restored printers:', printers.length, 'selected:', selectedPrinter?.name);
              } catch (printerError) {
                console.warn('[Init] Failed to restore printers:', printerError);
                updateState({ printers: [], selectedPrinter: null, printersLoaded: true });
              }
            } else if (savedAuth.stationId) {
              // No active session but we have a saved stationId - try to reclaim
              console.log('[Init] No active session, attempting to reclaim station:', savedAuth.stationId);
              try {
                const session = await apiClient.claimStation(savedAuth.stationId);
                const station = await apiClient.getStation(savedAuth.stationId);
                
                updateState({ station, session });
                
                if (wsClient) {
                  wsClient.subscribeToStation(savedAuth.stationId);
                }
                
                // Fetch printers for reclaimed station
                try {
                  const printers = await apiClient.getPrinters(savedAuth.stationId);
                  const selectedPrinter = printers.length > 0 
                    ? (printers.find(p => p.isDefault) || printers[0])
                    : null;
                  updateState({ printers, selectedPrinter, printersLoaded: true });
                  console.log('[Init] Reclaimed station, printers:', printers.length);
                } catch (printerError) {
                  console.warn('[Init] Failed to fetch printers after reclaim:', printerError);
                  updateState({ printers: [], selectedPrinter: null, printersLoaded: true });
                }
              } catch (reclaimError) {
                console.warn('[Init] Failed to reclaim station:', reclaimError);
                // Clear stale stationId from persistence and reset all station-related state
                await authService.updateStationId(null);
                updateState({ 
                  station: null, 
                  session: null, 
                  printers: [], 
                  selectedPrinter: null, 
                  printersLoaded: true 
                });
              }
            } else {
              // No session and no saved stationId
              console.log('[Init] No station session to restore');
              updateState({ printersLoaded: true });
            }
          } catch (sessionError) {
            console.warn('[Init] Error checking session:', sessionError);
            // Clear stale stationId if any and reset all station-related state
            if (savedAuth.stationId) {
              await authService.updateStationId(null);
            }
            updateState({ 
              station: null, 
              session: null, 
              printers: [], 
              selectedPrinter: null, 
              printersLoaded: true 
            });
          }
        } else {
          updateState({ printersLoaded: true });
        }
      } catch (error) {
        console.error('Failed to restore session:', error);
        await authService.clearAuth();
        updateState({ printersLoaded: true });
      }
    }
  } else {
    // No saved auth, mark printers as loaded (empty state)
    updateState({ printersLoaded: true });
  }
}

async function connectWebSocket(): Promise<void> {
  if (!appState.auth.token || !appState.auth.clientId) return;
  
  // Disconnect existing client if any
  if (wsClient) {
    wsClient.disconnect();
    wsClient = null;
  }
  
  updateState({ 
    connectionStatus: 'connecting',
    connectionInfo: { ...initialConnectionInfo, status: 'connecting' },
  });
  
  const env = getEnvironment(selectedEnvironment);
  
  // Fetch remote config before connecting (uses default values if fetch fails)
  try {
    const remoteConfig = await fetchRemoteConfig(env.serverUrl, appState.auth.token);
    if (remoteConfig) {
      runtimeConfig.updateFromRemote(remoteConfig);
      console.log('[Main] Applied remote config before WebSocket connection');
    }
  } catch (error) {
    console.warn('[Main] Failed to fetch remote config, using defaults:', error);
  }
  
  wsClient = new WebSocketClient(appState.auth.token, appState.auth.clientId, env.wsUrl);
  
  // Listen for detailed status changes
  wsClient.on('status-change', (info: ConnectionInfo) => {
    updateState({ 
      connectionStatus: info.status,
      connectionInfo: info,
    });
  });
  
  wsClient.on('connected', () => {
    if (appState.session?.stationId && wsClient) {
      wsClient.subscribeToStation(appState.session.stationId);
    }
    // Flush any pending status updates that couldn't be sent during disconnect
    flushPendingStatusUpdates();
  });
  
  wsClient.on('job:new', async (job: PrintJob) => {
    console.log(`[Main] Received new job ${job.id}`);
    
    // Capture printer reference SYNCHRONOUSLY before any awaits or state mutations
    // This ensures we use a consistent printer throughout the operation
    // Note: We intentionally use the printer that was selected at job start time
    const printer = getState().selectedPrinter;
    const printerName = printer?.name ?? null;
    const printerSystemName = printer?.systemName ?? null;
    
    // Add job to state (synchronous, atomic, deduplicates)
    const result = safeAddJob(job);
    
    if (!result.added) {
      // Job already exists - this is a duplicate from reconnect/retry
      // Replay the local status to server to reconcile (uses retry queue)
      const existingJob = result.existingJob;
      if (existingJob.status !== job.status) {
        console.log(`[Main] Job ${job.id} duplicate detected, replaying local status: ${existingJob.status}`);
        trySendStatusUpdate(getCurrentWsClient(), job.id, existingJob.status, existingJob.errorMessage);
      }
      // Don't process again - local state is already correct
      return;
    }
    
    // Immediately mark as picked_up - we have the job
    // Always update local state, attempt to send to server (queues if fails)
    safeUpdateJob(job.id, 'picked_up');
    const sentPickedUp = trySendStatusUpdate(getCurrentWsClient(), job.id, 'picked_up');
    console.log(`[Main] Job ${job.id} marked as picked_up (${sentPickedUp ? 'sent to server' : 'queued for retry'})`);
    
    // Check if we can print (using captured printer reference)
    if (!printerSystemName) {
      const errorMessage = 'No printer selected';
      console.error(`[Main] Job ${job.id} failed: ${errorMessage}`);
      safeUpdateJob(job.id, 'failed', errorMessage);
      trySendStatusUpdate(getCurrentWsClient(), job.id, 'failed', errorMessage);
      return;
    }
    
    // Mark as sent - we're about to print (uses captured printer name for logging)
    safeUpdateJob(job.id, 'sent');
    const sentSent = trySendStatusUpdate(getCurrentWsClient(), job.id, 'sent');
    console.log(`[Main] Job ${job.id} marked as sent (${sentSent ? 'sent to server' : 'queued'}), printing to ${printerName}`);
    
    try {
      // ASYNC: Use the captured printer reference we got at the start
      await printerService.print(job, printerSystemName);
      
      // AFTER AWAIT: Update local state first, then try to notify server (queues if fails)
      safeUpdateJob(job.id, 'completed');
      const sentCompleted = trySendStatusUpdate(getCurrentWsClient(), job.id, 'completed');
      console.log(`[Main] Job ${job.id} completed on ${printerName} (${sentCompleted ? 'sent to server' : 'queued for retry'})`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // AFTER AWAIT: Update local state first, then try to notify server (queues if fails)
      safeUpdateJob(job.id, 'failed', errorMessage);
      trySendStatusUpdate(getCurrentWsClient(), job.id, 'failed', errorMessage);
      console.error(`[Main] Job ${job.id} failed on ${printerName}:`, errorMessage);
    }
  });
  
  wsClient.on('job:update', (update: { jobId: string; status: PrintJob['status'] }) => {
    safeUpdateJob(update.jobId, update.status);
  });
  
  // Handle batch of pending jobs (sent when desktop reconnects to catch up on missed jobs)
  wsClient.on('job:batch', async (data: { stationId: string; jobs: PrintJob[] }) => {
    console.log(`[Main] Received batch of ${data.jobs.length} pending job(s)`);
    
    // Atomically add new jobs and get duplicates (synchronous, race-safe, deduplicates)
    const { newJobs: trulyNewJobs, duplicates } = safeAddBatchJobs(data.jobs);
    
    // Replay local status for any duplicates to reconcile with server (uses retry queue)
    if (duplicates.length > 0) {
      for (const localJob of duplicates) {
        // Find the incoming job to check if status differs
        const incomingJob = data.jobs.find(j => j.id === localJob.id);
        if (incomingJob && localJob.status !== incomingJob.status) {
          console.log(`[Main] Batch duplicate ${localJob.id} detected, replaying local status: ${localJob.status}`);
          trySendStatusUpdate(getCurrentWsClient(), localJob.id, localJob.status, localJob.errorMessage);
        }
      }
    }
    
    if (trulyNewJobs.length > 0) {
      console.log(`[Main] Added ${trulyNewJobs.length} new job(s) from batch`);
      
      // Process pending jobs that need printing (only those with 'pending' status)
      const jobsToPrint = trulyNewJobs.filter(j => j.status === 'pending');
      if (jobsToPrint.length > 0) {
        console.log(`[Main] Processing ${jobsToPrint.length} pending job(s) from batch`);
        
        for (const job of jobsToPrint) {
          // Capture printer reference SYNCHRONOUSLY before processing this job
          // Note: We intentionally use the printer that was selected at job start time
          const printer = getState().selectedPrinter;
          const printerName = printer?.name ?? null;
          const printerSystemName = printer?.systemName ?? null;
          
          // Immediately mark as picked_up - always update local state, use retry queue for server
          safeUpdateJob(job.id, 'picked_up');
          const sentPickedUp = trySendStatusUpdate(getCurrentWsClient(), job.id, 'picked_up');
          console.log(`[Main] Batch job ${job.id} marked as picked_up (${sentPickedUp ? 'sent' : 'queued'})`);
          
          if (!printerSystemName) {
            const errorMessage = 'No printer selected';
            console.error(`[Main] Batch job ${job.id} failed: ${errorMessage}`);
            safeUpdateJob(job.id, 'failed', errorMessage);
            trySendStatusUpdate(getCurrentWsClient(), job.id, 'failed', errorMessage);
            continue;
          }
          
          // Mark as sent - we're about to print
          safeUpdateJob(job.id, 'sent');
          const sentSent = trySendStatusUpdate(getCurrentWsClient(), job.id, 'sent');
          console.log(`[Main] Batch job ${job.id} marked as sent (${sentSent ? 'sent' : 'queued'}), printing to ${printerName}`);
          
          try {
            // ASYNC: Use captured printer reference
            await printerService.print(job, printerSystemName);
            
            // AFTER AWAIT: Update local state first, use retry queue for server
            safeUpdateJob(job.id, 'completed');
            const sentCompleted = trySendStatusUpdate(getCurrentWsClient(), job.id, 'completed');
            console.log(`[Main] Batch job ${job.id} completed on ${printerName} (${sentCompleted ? 'sent' : 'queued'})`);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            
            // AFTER AWAIT: Update local state first, use retry queue for server
            safeUpdateJob(job.id, 'failed', errorMessage);
            trySendStatusUpdate(getCurrentWsClient(), job.id, 'failed', errorMessage);
            console.error(`[Main] Batch job ${job.id} failed on ${printerName}:`, errorMessage);
          }
        }
      }
    } else {
      console.log(`[Main] All ${data.jobs.length} job(s) from batch already present`);
    }
  });
  
  wsClient.on('station-deleted', (data: { stationId: string; message: string }) => {
    console.log(`[Main] Station ${data.stationId} was deleted, releasing station session`);
    
    // Clear the station and session from app state
    updateState({
      station: null,
      session: null,
      printers: [],
      selectedPrinter: null,
      printJobs: [],
    });
    
    // Notify the renderer about the station deletion
    mainWindow?.webContents.send('station-deleted', data);
  });
  
  wsClient.on('station-updated', (data: { stationId: string; station: { id: string; name: string; locationHint: string | null; isActive: boolean } }) => {
    console.log(`[Main] Station ${data.stationId} was updated`);
    
    // Update the station in app state if it's our current station
    if (appState.station?.id === data.stationId) {
      updateState({
        station: {
          ...appState.station,
          name: data.station.name,
          locationHint: data.station.locationHint,
          isActive: data.station.isActive,
        },
      });
      console.log(`[Main] Updated station details in app state`);
    }
  });
  
  wsClient.on('config-update', (configData: Record<string, unknown>) => {
    console.log('[Main] Received config update from server:', configData);
    mainWindow?.webContents.send('config-updated', configData);
  });
  
  wsClient.connect();
}

function setupIpcHandlers(): void {
  ipcMain.handle('app:get-state', () => appState);
  
  ipcMain.handle('app:get-config', () => {
    return {
      success: true,
      data: runtimeConfig.remoteConfig,
    };
  });
  
  ipcMain.handle('auth:login', async () => {
    try {
      const result = await authService.login(selectedEnvironment);
      apiClient = new ApiClient(result.token, result.serverUrl);
      
      updateState({
        auth: {
          isAuthenticated: true,
          user: result.user,
          token: result.token,
          clientId: result.clientId,
        },
        environment: result.environment,
      });
      
      await connectWebSocket();
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('auth:logout', async () => {
    try {
      wsClient?.disconnect();
      wsClient = null;
      await authService.clearAuth(); // This also clears stationId
      
      updateState({
        auth: {
          isAuthenticated: false,
          user: null,
          token: null,
          clientId: null,
        },
        station: null,
        session: null,
        printers: [],
        selectedPrinter: null,
        printersLoaded: true, // Mark as loaded (empty state)
        printJobs: [],
        connectionStatus: 'disconnected',
        connectionInfo: { ...initialConnectionInfo },
      });
      
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Logout failed';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('station:list', async () => {
    try {
      if (!apiClient) throw new Error('Not authenticated');
      const stations = await apiClient.getStations();
      return { success: true, data: stations };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load stations';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('station:claim', async (_event, stationId: string) => {
    try {
      if (!apiClient) throw new Error('Not authenticated');
      const session = await apiClient.claimStation(stationId);
      const station = await apiClient.getStation(stationId);
      
      // Clear previous printer state before loading new station's printers
      updateState({ 
        station, 
        session, 
        printers: [], 
        selectedPrinter: null, 
        printersLoaded: false 
      });
      
      // Persist stationId for session restoration on restart
      await authService?.updateStationId(stationId);
      
      if (wsClient) {
        wsClient.subscribeToStation(stationId);
      }
      
      // Fetch printers for this station and auto-select if available
      try {
        const printers = await apiClient.getPrinters(stationId);
        const selectedPrinter = printers.length > 0 
          ? (printers.find(p => p.isDefault) || printers[0])
          : null;
        updateState({ printers, selectedPrinter, printersLoaded: true });
      } catch (printerError) {
        console.warn('[Main] Failed to fetch printers after claiming station:', printerError);
        // On fetch error, leave printers empty and mark as loaded
        updateState({ printers: [], selectedPrinter: null, printersLoaded: true });
      }
      
      return { success: true, data: { station, session } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to claim station';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('station:release', async () => {
    try {
      if (appState.session && apiClient) {
        await apiClient.releaseStation();
      }
      
      if (wsClient && appState.station) {
        wsClient.unsubscribeFromStation();
      }
      
      // Clear persisted stationId
      await authService?.updateStationId(null);
      
      updateState({ station: null, session: null, printers: [], selectedPrinter: null, printersLoaded: true });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to release station';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('station:create', async (_event, data: { name: string; locationHint?: string }) => {
    try {
      if (!apiClient) throw new Error('Not authenticated');
      const station = await apiClient.createStation(data);
      return { success: true, data: station };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create station';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('printer:discover', async () => {
    try {
      const systemPrinters = await printerService.discoverPrinters();
      return { success: true, data: systemPrinters };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to discover printers';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('printer:list', async () => {
    try {
      if (!appState.station || !apiClient) {
        // Clear printer state when no station/auth
        updateState({ printers: [], selectedPrinter: null, printersLoaded: true });
        return { success: true, data: [] };
      }
      const printers = await apiClient.getPrinters(appState.station.id);
      
      // Determine selected printer based on fetched printers
      let selectedPrinter = appState.selectedPrinter;
      if (printers.length > 0) {
        // If no printer selected, or selected printer not in list, select the first one
        const selectedStillExists = selectedPrinter && printers.some(p => p.id === selectedPrinter?.id);
        if (!selectedStillExists) {
          // Prefer the default printer, otherwise use the first one
          selectedPrinter = printers.find(p => p.isDefault) || printers[0];
        }
      } else {
        // No printers registered - clear selection
        selectedPrinter = null;
      }
      
      updateState({ printers, selectedPrinter, printersLoaded: true });
      return { success: true, data: printers };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load printers';
      updateState({ printersLoaded: true }); // Mark as loaded even on error
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('printer:register', async (_event, printerData: { name: string; systemName: string; status?: string }) => {
    try {
      if (!appState.station || !apiClient) {
        throw new Error('No station selected');
      }
      
      // Register printer with status included
      const printer = await apiClient.registerPrinter({
        name: printerData.name,
        systemName: printerData.systemName,
        stationId: appState.station.id,
        status: printerData.status || 'offline', // Default to offline if not provided
      });
      
      updateState({ printers: [...(appState.printers || []), printer] });
      return { success: true, data: printer };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to register printer';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('printer:set-default', async (_event, printerId: string) => {
    // Save current state for rollback on error
    const previousPrinter = appState.selectedPrinter;
    const previousPrinters = appState.printers;
    
    try {
      if (!appState.station || !apiClient) {
        throw new Error('No station selected');
      }
      
      // Optimistically update local state first for responsiveness
      const printer = (appState.printers || []).find(p => p.id === printerId);
      if (printer) {
        updateState({ selectedPrinter: printer });
      }
      
      // Call API to persist the default and broadcast to other clients
      const updatedPrinter = await apiClient.setDefaultPrinter(appState.station.id, printerId);
      
      // Refresh the printers list to get updated isDefault flags and consistent ordering
      const printers = await apiClient.getPrinters(appState.station.id);
      const selectedPrinter = printers.find(p => p.id === printerId) || updatedPrinter;
      updateState({ printers, selectedPrinter });
      
      console.log('[Main] Set default printer:', selectedPrinter.name);
      
      return { success: true, data: selectedPrinter };
    } catch (error) {
      // Revert to previous state on error
      updateState({ 
        selectedPrinter: previousPrinter,
        printers: previousPrinters,
      });
      
      const message = error instanceof Error ? error.message : 'Failed to set default printer';
      console.error('[Main] Failed to set default printer:', message);
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('ws:connect', async () => {
    await connectWebSocket();
    return { success: true };
  });
  
  ipcMain.handle('ws:disconnect', () => {
    wsClient?.disconnect();
    updateState({ connectionStatus: 'disconnected' });
    return { success: true };
  });
  
  ipcMain.handle('env:list', () => {
    return {
      success: true,
      data: environments.map(e => ({
        name: e.name,
        label: e.label,
        serverUrl: e.serverUrl,
      })),
    };
  });
  
  ipcMain.handle('env:get', () => {
    return { success: true, data: selectedEnvironment };
  });
  
  ipcMain.handle('env:set', async (_event, envName: string) => {
    const env = getEnvironment(envName);
    if (!env) {
      return { success: false, error: 'Invalid environment' };
    }
    
    const previousEnv = selectedEnvironment;
    selectedEnvironment = envName;
    
    if (previousEnv !== envName && appState.auth.isAuthenticated) {
      console.log(`[Env] Switching from ${previousEnv} to ${envName} while authenticated`);
      
      // Disconnect from current environment
      wsClient?.disconnect();
      wsClient = null;
      apiClient = null;
      
      // Clear station/session (environment-specific) but keep minimal UI state
      updateState({
        environment: envName,
        station: null,
        session: null,
        printers: [],
        selectedPrinter: null,
        printJobs: [],
        connectionStatus: 'disconnected',
      });
      
      // Save the new environment preference
      await saveEnvironmentSetting(envName);
      
      // Auto re-authenticate with the new environment
      try {
        console.log(`[Env] Re-authenticating with ${envName} environment...`);
        const result = await authService.login(envName);
        
        // Create new API client for new environment
        apiClient = new ApiClient(result.token, result.serverUrl);
        
        // Update state with new auth
        updateState({
          auth: {
            isAuthenticated: true,
            user: result.user,
            token: result.token,
            clientId: result.clientId,
          },
        });
        
        // Connect WebSocket to new environment
        await connectWebSocket();
        
        console.log(`[Env] Successfully switched to ${envName} environment`);
        return { success: true };
      } catch (error) {
        console.error(`[Env] Failed to authenticate with ${envName}:`, error);
        // Clear auth on failure
        await authService.clearAuth();
        updateState({
          auth: {
            isAuthenticated: false,
            user: null,
            token: null,
            clientId: null,
          },
        });
        return { success: false, error: 'Failed to authenticate with new environment' };
      }
    } else {
      updateState({ environment: envName });
      await saveEnvironmentSetting(envName);
    }
    
    return { success: true };
  });
  
  // Job retry handler - requeue a failed job for printing
  ipcMain.handle('job:retry', async (_event, jobId: string) => {
    console.log(`[Main] Retry requested for job ${jobId}`);
    
    // Find the job in local state
    const job = appState.printJobs.find(j => j.id === jobId);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }
    
    if (job.status !== 'failed') {
      return { success: false, error: 'Only failed jobs can be retried' };
    }
    
    // Get current printer
    const printer = appState.selectedPrinter;
    const printerName = printer?.name ?? null;
    const printerSystemName = printer?.systemName ?? null;
    
    if (!printerSystemName) {
      return { success: false, error: 'No printer selected' };
    }
    
    // Reset job status locally and start processing
    safeUpdateJob(jobId, 'picked_up');
    const ws = getCurrentWsClient();
    trySendStatusUpdate(ws, jobId, 'picked_up');
    console.log(`[Main] Retry job ${jobId} marked as picked_up`);
    
    // Mark as sent - about to print
    safeUpdateJob(jobId, 'sent');
    trySendStatusUpdate(getCurrentWsClient(), jobId, 'sent');
    console.log(`[Main] Retry job ${jobId} marked as sent, printing to ${printerName}`);
    
    try {
      await printerService.print(job, printerSystemName);
      
      safeUpdateJob(jobId, 'completed');
      trySendStatusUpdate(getCurrentWsClient(), jobId, 'completed');
      console.log(`[Main] Retry job ${jobId} completed successfully on ${printerName}`);
      
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      safeUpdateJob(jobId, 'failed', errorMessage);
      trySendStatusUpdate(getCurrentWsClient(), jobId, 'failed', errorMessage);
      console.error(`[Main] Retry job ${jobId} failed on ${printerName}:`, errorMessage);
      
      return { success: false, error: errorMessage };
    }
  });
}

async function loadEnvironmentSetting(): Promise<string> {
  try {
    const keytar = await import('keytar');
    const envName = await keytar.getPassword(config.keychainService, config.settingsAccount);
    if (envName && environments.some(e => e.name === envName)) {
      return envName;
    }
  } catch (error) {
    console.error('Failed to load environment setting:', error);
  }
  return config.defaultEnvironment;
}

async function saveEnvironmentSetting(envName: string): Promise<void> {
  try {
    const keytar = await import('keytar');
    await keytar.setPassword(config.keychainService, config.settingsAccount, envName);
    console.log('[Settings] Saved environment preference:', envName);
  } catch (error) {
    console.error('Failed to save environment setting:', error);
  }
}

function formatConfigValue(ms: number): string {
  if (ms >= 3600000) {
    return `${ms / 3600000} hour${ms / 3600000 !== 1 ? 's' : ''}`;
  }
  if (ms >= 60000) {
    return `${ms / 60000} minute${ms / 60000 !== 1 ? 's' : ''}`;
  }
  if (ms >= 1000) {
    return `${ms / 1000} second${ms / 1000 !== 1 ? 's' : ''}`;
  }
  return `${ms}ms`;
}

function showConfigurationDialog(): void {
  const cfg = runtimeConfig.remoteConfig;
  
  const configText = [
    'Current Desktop Configuration',
    '',
    `Connection Timeout: ${formatConfigValue(cfg.connectionTimeout)}`,
    `Base Reconnect Delay: ${formatConfigValue(cfg.baseReconnectDelay)}`,
    `Max Reconnect Delay: ${formatConfigValue(cfg.maxReconnectDelay)}`,
    `Heartbeat Interval: ${formatConfigValue(cfg.heartbeatInterval)}`,
    `Reconnect Interval: ${formatConfigValue(cfg.reconnectInterval)}`,
    `Token Refresh Interval: ${formatConfigValue(cfg.tokenRefreshInterval)}`,
    `Offline Timeout: ${formatConfigValue(cfg.offlineTimeout)}`,
    '',
    cfg.updatedAt ? `Last Updated: ${new Date(cfg.updatedAt).toLocaleString()}` : 'Using default values',
    '',
    'These settings are managed remotely from the web admin console.',
  ].join('\n');
  
  dialog.showMessageBox({
    type: 'info',
    title: 'Configuration',
    message: 'Desktop Configuration',
    detail: configText,
    buttons: ['OK'],
  });
}

function createApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'View Configuration',
          accelerator: isMac ? 'Cmd+,' : 'Ctrl+,',
          click: () => showConfigurationDialog(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' as const },
          { role: 'delete' as const },
          { role: 'selectAll' as const },
        ] : [
          { role: 'delete' as const },
          { type: 'separator' as const },
          { role: 'selectAll' as const },
        ]),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
          { type: 'separator' as const },
          { role: 'window' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },
    {
      role: 'help' as const,
      submenu: [
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://ship.jerky.com');
          },
        },
      ],
    },
  ];
  
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(async () => {
  createApplicationMenu();
  setupIpcHandlers();
  createWindow();
  await initializeApp();
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let isQuitting = false;

app.on('before-quit', async (event) => {
  if (isQuitting) {
    return; // Already handling quit
  }
  
  // If we have a WebSocket connection, send offline notification first
  if (wsClient) {
    event.preventDefault(); // Prevent immediate quit
    isQuitting = true;
    
    try {
      // Notify server that we're going offline gracefully, then disconnect
      await wsClient.sendGoingOfflineAndClose();
    } catch (error) {
      console.error('[Main] Error sending offline notification:', error);
    }
    
    wsClient.disconnect();
    app.quit(); // Now actually quit
  }
});
