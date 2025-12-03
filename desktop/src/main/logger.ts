import { BrowserWindow, app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { PrinterLogEntry, PrinterLogLevel, PrinterLogStage } from '../shared/types';

class PrinterLogger {
  private logFile: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private logBuffer: PrinterLogEntry[] = [];
  private maxBufferSize = 100;
  
  constructor() {
    this.initLogFile();
  }
  
  private initLogFile(): void {
    try {
      const userDataPath = app.getPath('userData');
      const logsDir = path.join(userDataPath, 'logs');
      
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      
      const today = new Date().toISOString().split('T')[0];
      this.logFile = path.join(logsDir, `printer-${today}.log`);
      
      console.log(`[Logger] Log file initialized: ${this.logFile}`);
    } catch (error) {
      console.error('[Logger] Failed to initialize log file:', error);
    }
  }
  
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }
  
  getLogFilePath(): string | null {
    return this.logFile;
  }
  
  getRecentLogs(count: number = 50): PrinterLogEntry[] {
    return this.logBuffer.slice(-count);
  }
  
  private getTimestamp(): number {
    return Date.now();
  }
  
  private writeToFile(entry: PrinterLogEntry): void {
    if (!this.logFile) return;
    
    try {
      // Include human-readable timestamp in file output
      const fileEntry = {
        ...entry,
        isoTime: new Date(entry.timestamp).toISOString(),
      };
      const line = JSON.stringify(fileEntry) + '\n';
      fs.appendFileSync(this.logFile, line);
    } catch (error) {
      console.error('[Logger] Failed to write to log file:', error);
    }
  }
  
  private sendToRenderer(entry: PrinterLogEntry): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send('printer:log', entry);
      } catch (error) {
        // Window might be closing, ignore
      }
    }
  }
  
  private addToBuffer(entry: PrinterLogEntry): void {
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }
  }
  
  log(
    level: PrinterLogLevel,
    stage: PrinterLogStage,
    message: string,
    details?: Record<string, unknown>,
    jobId?: string,
    orderNumber?: string
  ): void {
    const entry: PrinterLogEntry = {
      timestamp: this.getTimestamp(),
      level,
      stage,
      message,
      details,
      jobId,
      orderNumber,
    };
    
    // Console log with formatting
    const prefix = `[Printer/${stage}]`;
    const detailStr = details ? ` ${JSON.stringify(details)}` : '';
    
    switch (level) {
      case 'error':
        console.error(`${prefix} ${message}${detailStr}`);
        break;
      case 'warn':
        console.warn(`${prefix} ${message}${detailStr}`);
        break;
      case 'debug':
        console.debug(`${prefix} ${message}${detailStr}`);
        break;
      default:
        console.log(`${prefix} ${message}${detailStr}`);
    }
    
    // Write to file
    this.writeToFile(entry);
    
    // Add to buffer
    this.addToBuffer(entry);
    
    // Send to renderer
    this.sendToRenderer(entry);
  }
  
  // Convenience methods for each stage
  jobReceived(jobId: string, orderNumber: string, details: Record<string, unknown>): void {
    this.log('info', 'JOB_RECEIVED', `Print job received: ${orderNumber}`, details, jobId, orderNumber);
  }
  
  labelDownload(jobId: string, orderNumber: string, url: string, status: 'starting' | 'success' | 'failed', details?: Record<string, unknown>): void {
    const message = status === 'starting' 
      ? `Downloading label from: ${url}`
      : status === 'success'
        ? 'Label downloaded successfully'
        : 'Label download failed';
    this.log(status === 'failed' ? 'error' : 'info', 'LABEL_DOWNLOAD', message, details, jobId, orderNumber);
  }
  
  commandInvoked(jobId: string, orderNumber: string, command: string, args: string[], details?: Record<string, unknown>): void {
    this.log('info', 'COMMAND_INVOKED', `Executing: ${command}`, { 
      command,
      args,
      fullCommand: `${command} ${args.join(' ')}`,
      ...details 
    }, jobId, orderNumber);
  }
  
  printing(jobId: string, orderNumber: string, message: string, details?: Record<string, unknown>): void {
    this.log('info', 'PRINTING', message, details, jobId, orderNumber);
  }
  
  result(jobId: string, orderNumber: string, success: boolean, message: string, details?: Record<string, unknown>): void {
    this.log(success ? 'info' : 'error', 'RESULT', message, { success, ...details }, jobId, orderNumber);
  }
  
  diagnostic(message: string, details?: Record<string, unknown>): void {
    this.log('debug', 'DIAGNOSTIC', message, details);
  }
}

// Singleton instance
export const printerLogger = new PrinterLogger();
