import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { PrintJob } from '../shared/types';

const execAsync = promisify(exec);

interface SystemPrinter {
  name: string;
  systemName: string;
  isDefault: boolean;
  status: string;
}

export class PrinterService {
  private tempDir: string;
  private platform: NodeJS.Platform;
  
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'jerky-ship-connect');
    this.platform = process.platform;
  }
  
  async discoverPrinters(): Promise<SystemPrinter[]> {
    try {
      if (this.platform === 'win32') {
        return await this.discoverWindowsPrinters();
      } else {
        return await this.discoverMacPrinters();
      }
    } catch (error) {
      console.error('Failed to discover printers:', error);
      return [];
    }
  }
  
  private async discoverMacPrinters(): Promise<SystemPrinter[]> {
    const { stdout } = await execAsync('lpstat -p -d 2>/dev/null || true');
    const printers: SystemPrinter[] = [];
    let defaultPrinter = '';
    
    const lines = stdout.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('system default destination:')) {
        defaultPrinter = line.split(':')[1]?.trim() || '';
      } else if (line.startsWith('printer')) {
        const match = line.match(/^printer\s+(\S+)\s+(.*)$/);
        if (match) {
          const systemName = match[1];
          const statusPart = match[2];
          
          const isEnabled = statusPart.includes('enabled');
          const isIdle = statusPart.includes('idle');
          
          let status = 'offline';
          if (isEnabled && isIdle) {
            status = 'online';
          } else if (isEnabled) {
            status = 'busy';
          }
          
          printers.push({
            name: systemName.replace(/_/g, ' '),
            systemName,
            isDefault: systemName === defaultPrinter,
            status,
          });
        }
      }
    }
    
    return printers;
  }
  
  private async discoverWindowsPrinters(): Promise<SystemPrinter[]> {
    const printers: SystemPrinter[] = [];
    
    try {
      const { stdout } = await execAsync(
        'powershell -Command "Get-Printer | Select-Object Name, PrinterStatus, Default | ConvertTo-Json"',
        { encoding: 'utf8' }
      );
      
      if (!stdout.trim()) {
        return [];
      }
      
      let printerList = JSON.parse(stdout);
      
      if (!Array.isArray(printerList)) {
        printerList = [printerList];
      }
      
      for (const printer of printerList) {
        let status = 'offline';
        if (printer.PrinterStatus === 0 || printer.PrinterStatus === 'Normal') {
          status = 'online';
        } else if (printer.PrinterStatus === 1 || printer.PrinterStatus === 'Paused') {
          status = 'offline';
        } else if (printer.PrinterStatus === 3 || printer.PrinterStatus === 'Printing') {
          status = 'busy';
        }
        
        printers.push({
          name: printer.Name,
          systemName: printer.Name,
          isDefault: printer.Default === true,
          status,
        });
      }
    } catch (error) {
      console.error('Failed to discover Windows printers:', error);
      
      try {
        const { stdout } = await execAsync('wmic printer get name,default,status', { encoding: 'utf8' });
        const lines = stdout.split('\n').filter(line => line.trim());
        
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].trim().split(/\s{2,}/);
          if (parts.length >= 2) {
            const isDefault = parts[0]?.toLowerCase() === 'true';
            const name = parts[1] || '';
            const status = parts[2]?.toLowerCase() === 'ok' ? 'online' : 'offline';
            
            if (name) {
              printers.push({
                name,
                systemName: name,
                isDefault,
                status,
              });
            }
          }
        }
      } catch (wmicError) {
        console.error('WMIC fallback also failed:', wmicError);
      }
    }
    
    return printers;
  }
  
  async print(job: PrintJob, printerName: string): Promise<void> {
    console.log(`[Printer] Printing job ${job.id} to ${printerName}`);
    
    await fs.mkdir(this.tempDir, { recursive: true });
    
    const labelPath = path.join(this.tempDir, `label-${job.id}.pdf`);
    
    try {
      if (job.labelData) {
        const buffer = Buffer.from(job.labelData, 'base64');
        await fs.writeFile(labelPath, buffer);
      } else if (job.labelUrl) {
        await this.downloadLabel(job.labelUrl, labelPath);
      } else {
        throw new Error('No label data or URL provided');
      }
      
      await this.printFile(labelPath, printerName);
      
      console.log(`[Printer] Job ${job.id} printed successfully`);
    } finally {
      try {
        await fs.unlink(labelPath);
      } catch {
      }
    }
  }
  
  private async downloadLabel(url: string, destPath: string): Promise<void> {
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to download label: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    await fs.writeFile(destPath, Buffer.from(buffer));
  }
  
  private async printFile(filePath: string, printerName: string): Promise<void> {
    if (this.platform === 'win32') {
      return this.printFileWindows(filePath, printerName);
    } else {
      return this.printFileMac(filePath, printerName);
    }
  }
  
  private async printFileMac(filePath: string, printerName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-d', printerName,
        '-o', 'fit-to-page',
        '-o', 'media=4x6',
        filePath,
      ];
      
      console.log(`[Printer] Executing: lp ${args.join(' ')}`);
      
      const process = spawn('lp', args);
      
      let stderr = '';
      
      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`lp exited with code ${code}: ${stderr}`));
        }
      });
      
      process.on('error', (error) => {
        reject(error);
      });
    });
  }
  
  private async printFileWindows(filePath: string, printerName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[Printer] Executing Windows print command for ${printerName}`);
      
      // Use spawn with argument array to avoid shell escaping issues
      // PowerShell's Start-Process with PrintTo verb sends file to specified printer
      const psCommand = `Start-Process -FilePath '${filePath.replace(/'/g, "''")}' -Verb PrintTo -ArgumentList '${printerName.replace(/'/g, "''")}' -Wait`;
      
      const printProcess = spawn('powershell', ['-NoProfile', '-Command', psCommand], {
        shell: false,
        windowsHide: true,
      });
      
      let stderr = '';
      
      printProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      printProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          console.error('[Printer] Windows print error:', stderr);
          
          // Fallback: Use spawn to avoid shell injection issues
          console.log(`[Printer] Trying fallback print command`);
          
          const fallbackProcess = spawn('cmd', ['/c', 'print', `/d:${printerName}`, filePath], {
            shell: false,
            windowsHide: true,
          });
          
          let fallbackStderr = '';
          
          fallbackProcess.stderr.on('data', (data) => {
            fallbackStderr += data.toString();
          });
          
          fallbackProcess.on('close', (fallbackCode) => {
            if (fallbackCode === 0) {
              resolve();
            } else {
              reject(new Error(`Print failed: ${fallbackStderr || stderr || 'Unknown error'}`));
            }
          });
          
          fallbackProcess.on('error', (error) => {
            reject(error);
          });
        }
      });
      
      printProcess.on('error', (error) => {
        reject(error);
      });
    });
  }
  
  async testPrint(printerName: string): Promise<boolean> {
    try {
      const testPath = path.join(this.tempDir, 'test-print.txt');
      await fs.mkdir(this.tempDir, { recursive: true });
      await fs.writeFile(testPath, 'Jerky Ship Connect Test Print\n' + new Date().toISOString());
      
      await this.printFile(testPath, printerName);
      
      await fs.unlink(testPath);
      return true;
    } catch (error) {
      console.error('Test print failed:', error);
      return false;
    }
  }
}
