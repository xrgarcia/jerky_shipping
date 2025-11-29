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
        await apiClient.releaseStation();
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
