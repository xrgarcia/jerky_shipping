import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { AuthService } from './auth';
import { WebSocketClient } from './websocket';
import { PrinterService } from './printer';
import { ApiClient } from './api';
import { AppState, Station, StationSession, PrintJob } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let authService: AuthService;
let wsClient: WebSocketClient;
let printerService: PrinterService;
let apiClient: ApiClient;

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
  printJobs: [],
  connectionStatus: 'disconnected',
};

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 400,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
    backgroundColor: '#1a1a1a',
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
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

async function initializeApp(): Promise<void> {
  authService = new AuthService();
  printerService = new PrinterService();
  
  const savedAuth = await authService.loadSavedAuth();
  if (savedAuth) {
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
    } catch (error) {
      console.error('Failed to restore session:', error);
      await authService.clearAuth();
    }
  }
}

async function connectWebSocket(): Promise<void> {
  if (!appState.auth.token || !appState.auth.clientId) return;
  
  updateState({ connectionStatus: 'connecting' });
  
  wsClient = new WebSocketClient(appState.auth.token, appState.auth.clientId);
  
  wsClient.on('connected', () => {
    updateState({ connectionStatus: 'connected' });
    
    if (appState.session?.stationId) {
      wsClient.subscribeToStation(appState.session.stationId);
    }
  });
  
  wsClient.on('disconnected', () => {
    updateState({ connectionStatus: 'disconnected' });
  });
  
  wsClient.on('job:new', async (job: PrintJob) => {
    updateState({
      printJobs: [job, ...appState.printJobs],
    });
    
    if (appState.selectedPrinter) {
      try {
        await printerService.print(job, appState.selectedPrinter.systemName);
        wsClient.sendJobUpdate(job.id, 'completed');
        updateState({
          printJobs: appState.printJobs.map(j => 
            j.id === job.id ? { ...j, status: 'completed' as const } : j
          ),
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        wsClient.sendJobUpdate(job.id, 'failed', errorMessage);
        updateState({
          printJobs: appState.printJobs.map(j => 
            j.id === job.id ? { ...j, status: 'failed' as const, errorMessage } : j
          ),
        });
      }
    }
  });
  
  wsClient.on('job:update', (update: { jobId: string; status: PrintJob['status'] }) => {
    updateState({
      printJobs: appState.printJobs.map(j => 
        j.id === update.jobId ? { ...j, status: update.status } : j
      ),
    });
  });
  
  wsClient.connect();
}

function setupIpcHandlers(): void {
  ipcMain.handle('app:get-state', () => appState);
  
  ipcMain.handle('auth:login', async () => {
    try {
      const result = await authService.login();
      apiClient = new ApiClient(result.token, result.serverUrl);
      
      updateState({
        auth: {
          isAuthenticated: true,
          user: result.user,
          token: result.token,
          clientId: result.clientId,
        },
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
      await authService.clearAuth();
      
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
        printJobs: [],
        connectionStatus: 'disconnected',
      });
      
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Logout failed';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('station:list', async () => {
    try {
      const stations = await apiClient.getStations();
      return { success: true, data: stations };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load stations';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('station:claim', async (_, stationId: string) => {
    try {
      const session = await apiClient.claimStation(stationId);
      const station = await apiClient.getStation(stationId);
      
      updateState({ station, session });
      
      if (wsClient) {
        wsClient.subscribeToStation(stationId);
      }
      
      return { success: true, data: { station, session } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to claim station';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('station:release', async () => {
    try {
      if (appState.session) {
        await apiClient.releaseStation(appState.session.id);
      }
      
      if (wsClient && appState.station) {
        wsClient.unsubscribeFromStation();
      }
      
      updateState({ station: null, session: null });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to release station';
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
      if (!appState.station) {
        return { success: true, data: [] };
      }
      const printers = await apiClient.getPrinters(appState.station.id);
      updateState({ printers });
      return { success: true, data: printers };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load printers';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('printer:register', async (_, printerData: { name: string; systemName: string }) => {
    try {
      if (!appState.station) {
        throw new Error('No station selected');
      }
      const printer = await apiClient.registerPrinter({
        ...printerData,
        stationId: appState.station.id,
      });
      updateState({ printers: [...appState.printers, printer] });
      return { success: true, data: printer };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to register printer';
      return { success: false, error: message };
    }
  });
  
  ipcMain.handle('printer:set-default', async (_, printerId: string) => {
    try {
      const printer = appState.printers.find(p => p.id === printerId);
      if (printer) {
        updateState({ selectedPrinter: printer });
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to set default printer';
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
}

app.whenReady().then(async () => {
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

app.on('before-quit', () => {
  wsClient?.disconnect();
});
