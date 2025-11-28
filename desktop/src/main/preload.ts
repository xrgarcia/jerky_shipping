import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, IpcChannel, IpcResponse, EnvironmentInfo } from '../shared/types';

const api = {
  invoke: <T = unknown>(channel: IpcChannel, data?: unknown): Promise<IpcResponse<T>> => {
    return ipcRenderer.invoke(channel, data);
  },
  
  onStateChange: (callback: (state: AppState) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, state: AppState) => callback(state);
    ipcRenderer.on('app:state-changed', handler);
    return () => ipcRenderer.removeListener('app:state-changed', handler);
  },
  
  getState: (): Promise<AppState> => {
    return ipcRenderer.invoke('app:get-state');
  },
  
  auth: {
    login: () => ipcRenderer.invoke('auth:login'),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  
  station: {
    list: () => ipcRenderer.invoke('station:list'),
    claim: (stationId: string) => ipcRenderer.invoke('station:claim', stationId),
    release: () => ipcRenderer.invoke('station:release'),
  },
  
  printer: {
    discover: () => ipcRenderer.invoke('printer:discover'),
    list: () => ipcRenderer.invoke('printer:list'),
    register: (data: { name: string; systemName: string }) => 
      ipcRenderer.invoke('printer:register', data),
    setDefault: (printerId: string) => ipcRenderer.invoke('printer:set-default', printerId),
  },
  
  ws: {
    connect: () => ipcRenderer.invoke('ws:connect'),
    disconnect: () => ipcRenderer.invoke('ws:disconnect'),
  },
  
  environment: {
    list: (): Promise<IpcResponse<EnvironmentInfo[]>> => ipcRenderer.invoke('env:list'),
    get: (): Promise<IpcResponse<string>> => ipcRenderer.invoke('env:get'),
    set: (envName: string): Promise<IpcResponse<void>> => ipcRenderer.invoke('env:set', envName),
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

export type ElectronAPI = typeof api;
