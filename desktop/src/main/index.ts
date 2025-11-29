import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'path';

// Build marker - change this to verify new code is being used
const BUILD_VERSION = 'v1.0.1-fix1';
import { AuthService } from './auth';
import { WebSocketClient } from './websocket';
import { PrinterService } from './printer';
import { ApiClient } from './api';
import { AppState, PrintJob } from '../shared/types';
import { environments, config, getEnvironment } from '../shared/config';

let mainWindow: BrowserWindow | null = null;
let authService: AuthService;
let wsClient: WebSocketClient | null = null;
let printerService: PrinterService;
let apiClient: ApiClient | null = null;

let selectedEnvironment = config.defaultEnvironment;

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
  environment: selectedEnvironment,
};

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  
  const preloadPath = process.env.NODE_ENV === 'development'
    ? path.join(__dirname, 'preload.js')
    : path.join(app.getAppPath(), 'dist', 'main', 'main', 'preload.js');
  
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
    
    // Show build info dialog to verify correct code is being used
    dialog.showMessageBox({
      type: 'info',
      title: 'Build Info',
      message: `Jerky Ship Connect ${BUILD_VERSION}`,
      detail: `App Path: ${appPath}\nRenderer: ${rendererPath}\nPreload: ${preloadPath}`,
      buttons: ['OK']
    });
    
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
      } catch (error) {
        console.error('Failed to restore session:', error);
        await authService.clearAuth();
      }
    }
  }
}

async function connectWebSocket(): Promise<void> {
  if (!appState.auth.token || !appState.auth.clientId) return;
  
  updateState({ connectionStatus: 'connecting' });
  
  const env = getEnvironment(selectedEnvironment);
  wsClient = new WebSocketClient(appState.auth.token, appState.auth.clientId, env.wsUrl);
  
  wsClient.on('connected', () => {
    updateState({ connectionStatus: 'connected' });
    
    if (appState.session?.stationId && wsClient) {
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
    
    if (appState.selectedPrinter && wsClient) {
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
      if (appState.session && apiClient) {
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
      if (!appState.station || !apiClient) {
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
  
  ipcMain.handle('printer:register', async (_event, printerData: { name: string; systemName: string }) => {
    try {
      if (!appState.station || !apiClient) {
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
  
  ipcMain.handle('printer:set-default', async (_event, printerId: string) => {
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
      wsClient?.disconnect();
      wsClient = null;
      apiClient = null;
      await authService.clearAuth();
      
      updateState({
        environment: envName,
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
    } else {
      updateState({ environment: envName });
    }
    
    await saveEnvironmentSetting(envName);
    
    return { success: true };
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
