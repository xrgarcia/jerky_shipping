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
  
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'jerky-ship-connect');
  }
  
  async discoverPrinters(): Promise<SystemPrinter[]> {
    try {
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
    } catch (error) {
      console.error('Failed to discover printers:', error);
      return [];
    }
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
