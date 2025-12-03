import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import type { PrintJob } from '../shared/types';
import { printerLogger } from './logger';

const execAsync = promisify(exec);

interface SystemPrinter {
  name: string;
  systemName: string;
  isDefault: boolean;
  status: string;
}

interface PdfViewerInfo {
  installed: boolean;
  viewer: string | null;
  path: string | null;
}

export class PrinterService {
  private tempDir: string;
  private platform: NodeJS.Platform;
  private cachedPdfViewer: PdfViewerInfo | null = null;
  private bundledSumatraPath: string | null = null;
  
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'jerky-ship-connect');
    this.platform = process.platform;
    this.initBundledPaths();
  }
  
  /**
   * Initialize paths to bundled executables.
   * In production, these are in resources/bin/.
   * In development, they're in binaries/win/.
   */
  private initBundledPaths(): void {
    if (this.platform === 'win32') {
      if (app.isPackaged) {
        this.bundledSumatraPath = path.join(process.resourcesPath, 'bin', 'SumatraPDF.exe');
      } else {
        this.bundledSumatraPath = path.join(__dirname, '..', '..', '..', 'binaries', 'win', 'SumatraPDF.exe');
      }
      console.log(`[PrinterService] Bundled SumatraPDF path: ${this.bundledSumatraPath}`);
    }
  }
  
  /**
   * Detect if a PDF viewer is installed on Windows.
   * Returns cached result after first detection.
   * macOS always returns installed since it uses lp command.
   * 
   * Priority:
   * 1. Bundled SumatraPDF (always available in packaged app)
   * 2. System-installed SumatraPDF
   * 3. Adobe Reader
   * 4. System default PDF handler
   */
  async detectPdfViewer(): Promise<PdfViewerInfo> {
    console.log('[PrinterService] detectPdfViewer called');
    
    // macOS uses lp which doesn't need a PDF viewer
    if (this.platform !== 'win32') {
      console.log('[PrinterService] macOS detected - using native lp command, no PDF viewer needed');
      return { installed: true, viewer: 'lp (macOS native)', path: null };
    }
    
    // Return cached result if available
    if (this.cachedPdfViewer) {
      console.log('[PrinterService] Returning cached PDF viewer info:', this.cachedPdfViewer);
      return this.cachedPdfViewer;
    }
    
    console.log('[PrinterService] Searching for PDF viewers on Windows...');
    
    // Check bundled SumatraPDF first (always preferred)
    if (this.bundledSumatraPath) {
      console.log(`[PrinterService] Checking bundled SumatraPDF at: ${this.bundledSumatraPath}`);
      try {
        await fs.access(this.bundledSumatraPath);
        console.log(`[PrinterService] FOUND bundled SumatraPDF at: ${this.bundledSumatraPath}`);
        this.cachedPdfViewer = { installed: true, viewer: 'SumatraPDF (bundled)', path: this.bundledSumatraPath };
        return this.cachedPdfViewer;
      } catch {
        console.log('[PrinterService] Bundled SumatraPDF not found, checking system paths...');
      }
    }
    
    // Fallback: Check system-installed SumatraPDF
    const sumatraPaths = [
      'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
      'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
      `${process.env.LOCALAPPDATA}\\SumatraPDF\\SumatraPDF.exe`,
      `${process.env.APPDATA}\\SumatraPDF\\SumatraPDF.exe`,
      `${process.env.USERPROFILE}\\SumatraPDF\\SumatraPDF.exe`,
      `${process.env.USERPROFILE}\\Downloads\\SumatraPDF.exe`,
    ];
    
    for (const sumatraPath of sumatraPaths) {
      if (!sumatraPath) continue;
      console.log(`[PrinterService] Checking SumatraPDF at: ${sumatraPath}`);
      try {
        await fs.access(sumatraPath);
        console.log(`[PrinterService] FOUND SumatraPDF at: ${sumatraPath}`);
        this.cachedPdfViewer = { installed: true, viewer: 'SumatraPDF', path: sumatraPath };
        return this.cachedPdfViewer;
      } catch {
        // Continue to next path
      }
    }
    
    // Check Adobe Reader
    const adobePaths = [
      'C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe',
      'C:\\Program Files (x86)\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe',
      'C:\\Program Files\\Adobe\\Reader 11.0\\Reader\\AcroRd32.exe',
    ];
    
    for (const adobePath of adobePaths) {
      console.log(`[PrinterService] Checking Adobe Reader at: ${adobePath}`);
      try {
        await fs.access(adobePath);
        console.log(`[PrinterService] FOUND Adobe Reader at: ${adobePath}`);
        this.cachedPdfViewer = { installed: true, viewer: 'Adobe Reader', path: adobePath };
        return this.cachedPdfViewer;
      } catch {
        // Continue to next path
      }
    }
    
    // Check if there's a default PDF handler via registry/associations
    try {
      console.log('[PrinterService] Checking for default PDF handler via file association...');
      const { stdout } = await execAsync('cmd /c assoc .pdf', { encoding: 'utf8' });
      console.log(`[PrinterService] PDF association: ${stdout.trim()}`);
      
      if (stdout.includes('=')) {
        const { stdout: ftypeOutput } = await execAsync('cmd /c ftype ' + stdout.split('=')[1]?.trim(), { encoding: 'utf8' });
        console.log(`[PrinterService] PDF handler: ${ftypeOutput.trim()}`);
        
        // Case-insensitive check for .exe (Windows registry can have uppercase .EXE)
        if (ftypeOutput.toLowerCase().includes('.exe')) {
          console.log('[PrinterService] Found a default PDF handler via file association');
          this.cachedPdfViewer = { installed: true, viewer: 'System Default', path: null };
          return this.cachedPdfViewer;
        }
      }
    } catch (err) {
      console.log('[PrinterService] Could not determine PDF file association:', err);
    }
    
    console.log('[PrinterService] No PDF viewer found');
    this.cachedPdfViewer = { installed: false, viewer: null, path: null };
    return this.cachedPdfViewer;
  }
  
  /**
   * Clear the cached PDF viewer info (useful if user installs viewer while app is running)
   */
  clearPdfViewerCache(): void {
    console.log('[PrinterService] Clearing PDF viewer cache');
    this.cachedPdfViewer = null;
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
        
        const name = printer.Name;
        printers.push({
          name,
          systemName: name,
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
    // Log job received - this is the entry point
    printerLogger.jobReceived(job.id, job.orderNumber, {
      printer: printerName,
      hasLabelData: !!job.labelData,
      hasLabelUrl: !!job.labelUrl,
      labelUrlPreview: job.labelUrl ? job.labelUrl.substring(0, 100) + '...' : null,
      platform: this.platform,
      requestedBy: job.requestedBy,
    });
    
    await fs.mkdir(this.tempDir, { recursive: true });
    
    // Use unique filename with timestamp to prevent race conditions
    const timestamp = Date.now();
    let labelPath: string | null = null;
    
    try {
      let expectedBytes = 0;
      let labelFormat: 'zpl' | 'pdf' = 'pdf';
      
      if (job.labelData) {
        // Base64 data - assume PDF unless we can detect otherwise
        const buffer = Buffer.from(job.labelData, 'base64');
        expectedBytes = buffer.length;
        
        // Check if it starts with ZPL command (^XA)
        const headerStr = buffer.toString('utf8', 0, Math.min(100, buffer.length));
        if (headerStr.includes('^XA')) {
          labelFormat = 'zpl';
        }
        
        labelPath = path.join(this.tempDir, `label-${job.id}-${timestamp}.${labelFormat}`);
        await fs.writeFile(labelPath, buffer);
        printerLogger.labelDownload(job.id, job.orderNumber, 'base64-data', 'success', {
          source: 'base64',
          bytes: buffer.length,
          format: labelFormat,
        });
      } else if (job.labelUrl) {
        // First download to detect format, then set correct extension
        const tempPath = path.join(this.tempDir, `label-${job.id}-${timestamp}.tmp`);
        printerLogger.labelDownload(job.id, job.orderNumber, job.labelUrl, 'starting');
        
        const result = await this.downloadLabel(job.labelUrl, tempPath);
        expectedBytes = result.bytes;
        labelFormat = result.format;
        
        // Rename to correct extension
        labelPath = path.join(this.tempDir, `label-${job.id}-${timestamp}.${labelFormat}`);
        await fs.rename(tempPath, labelPath);
        
        printerLogger.labelDownload(job.id, job.orderNumber, job.labelUrl, 'success', {
          bytes: expectedBytes,
          format: labelFormat,
        });
      } else {
        printerLogger.result(job.id, job.orderNumber, false, 'No label data or URL provided');
        throw new Error('No label data or URL provided');
      }
      
      printerLogger.printing(job.id, job.orderNumber, `Temp file path: ${labelPath}`, { 
        tempDir: this.tempDir,
        format: labelFormat,
      });
      
      // Verify file exists AND has correct size before printing
      const stats = await fs.stat(labelPath).catch(() => null);
      if (!stats) {
        printerLogger.result(job.id, job.orderNumber, false, 'Label file not found after download');
        throw new Error('Label file not found after download');
      }
      
      if (stats.size === 0) {
        printerLogger.result(job.id, job.orderNumber, false, 'Label file is empty (0 bytes)');
        throw new Error('Label file is empty (0 bytes)');
      }
      
      if (stats.size < 100) {
        printerLogger.result(job.id, job.orderNumber, false, `Label file too small: ${stats.size} bytes`);
        throw new Error(`Label file too small: ${stats.size} bytes - likely corrupt or incomplete`);
      }
      
      // Log file size verification
      printerLogger.printing(job.id, job.orderNumber, `File verified: ${stats.size} bytes (${labelFormat.toUpperCase()})`, {
        filePath: labelPath,
        fileSize: stats.size,
        expectedBytes,
        format: labelFormat,
      });
      
      printerLogger.printing(job.id, job.orderNumber, `Starting ${labelFormat.toUpperCase()} print to: ${printerName}`, {
        filePath: labelPath,
        format: labelFormat,
      });
      
      // Route to appropriate print method based on format
      if (labelFormat === 'zpl') {
        await this.printZplFile(labelPath, printerName);
      } else {
        await this.printFile(labelPath, printerName);
      }
      
      printerLogger.result(job.id, job.orderNumber, true, `${labelFormat.toUpperCase()} print job completed successfully`, {
        printer: printerName,
        format: labelFormat,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      printerLogger.result(job.id, job.orderNumber, false, `Print job failed: ${errorMsg}`, {
        error: errorMsg,
        printer: printerName,
      });
      throw error;
    } finally {
      if (labelPath) {
        try {
          await fs.unlink(labelPath);
          printerLogger.printing(job.id, job.orderNumber, 'Cleaned up temp file');
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
  
  /**
   * Detect label format from URL and content-type
   * Returns 'zpl' for ZPL labels, 'pdf' for PDF labels
   */
  private detectLabelFormat(url: string, contentType: string | null): 'zpl' | 'pdf' {
    // Check URL extension first
    const urlLower = url.toLowerCase();
    if (urlLower.includes('.zpl')) {
      return 'zpl';
    }
    
    // Check content-type header
    if (contentType) {
      const ctLower = contentType.toLowerCase();
      if (ctLower.includes('zpl') || ctLower.includes('x-zpl')) {
        return 'zpl';
      }
    }
    
    // Default to PDF
    return 'pdf';
  }
  
  private async downloadLabel(url: string, destPath: string): Promise<{ bytes: number; format: 'zpl' | 'pdf' }> {
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to download label: ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type');
    const format = this.detectLabelFormat(url, contentType);
    
    printerLogger.diagnostic(`Label format detected: ${format}`, {
      url: url.substring(0, 100),
      contentType,
    });
    
    const buffer = await response.arrayBuffer();
    const nodeBuffer = Buffer.from(buffer);
    await fs.writeFile(destPath, nodeBuffer);
    return { bytes: nodeBuffer.length, format };
  }
  
  private async printFile(filePath: string, printerName: string): Promise<void> {
    if (this.platform === 'win32') {
      return this.printFileWindows(filePath, printerName);
    } else {
      return this.printFileMac(filePath, printerName);
    }
  }
  
  /**
   * Print ZPL file directly to thermal printer using raw mode
   * ZPL is already printer commands - send directly without conversion
   */
  private async printZplFile(filePath: string, printerName: string): Promise<void> {
    if (this.platform === 'win32') {
      return this.printZplWindows(filePath, printerName);
    } else {
      return this.printZplMac(filePath, printerName);
    }
  }
  
  /**
   * Send ZPL to printer on Windows using raw print via winspool.Drv
   * Uses RawPrinterHelper for all printer types (USB, network, etc.)
   */
  private async printZplWindows(filePath: string, printerName: string): Promise<void> {
    console.log('[Printer] ====== WINDOWS ZPL RAW PRINT ======');
    console.log(`[Printer] Printer: "${printerName}"`);
    console.log(`[Printer] ZPL file: "${filePath}"`);
    
    // Read the ZPL content
    const zplContent = await fs.readFile(filePath, 'utf8');
    console.log(`[Printer] ZPL content size: ${zplContent.length} bytes`);
    console.log(`[Printer] ZPL preview: ${zplContent.substring(0, 100)}...`);
    
    return new Promise((resolve, reject) => {
      // PowerShell script to send raw data to printer using RawPrinterHelper
      // This uses Windows Print Spooler API (winspool.Drv) for reliable raw printing
      const psScript = `
$ErrorActionPreference = 'Stop'
$printerName = '${printerName.replace(/'/g, "''")}'
$zplFile = '${filePath.replace(/\\/g, '\\\\').replace(/'/g, "''")}'

try {
    Write-Host "[ZPL] Reading ZPL file: $zplFile"
    $zplContent = [System.IO.File]::ReadAllBytes($zplFile)
    Write-Host "[ZPL] ZPL data size: $($zplContent.Length) bytes"
    
    # Verify printer exists
    $printer = Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Name = '$($printerName.Replace('\\', '\\\\'))'" -ErrorAction SilentlyContinue
    if ($printer) {
        Write-Host "[ZPL] Printer found: $($printer.Name)"
        Write-Host "[ZPL] Printer port: $($printer.PortName)"
        Write-Host "[ZPL] Printer driver: $($printer.DriverName)"
    } else {
        Write-Host "[ZPL] WARNING: Could not query printer details via WMI, proceeding anyway..."
    }
    
    # Use RawPrinterHelper for ALL printer types (USB, network, virtual)
    # This is the most reliable method and works with any Windows printer
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    
    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
    
    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    
    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
    
    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    
    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    
    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    
    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);
    
    public static string SendBytesToPrinter(string printerName, byte[] bytes) {
        IntPtr hPrinter = IntPtr.Zero;
        
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
            return "OpenPrinter failed: " + Marshal.GetLastWin32Error();
        }
        
        try {
            DOCINFOA di = new DOCINFOA();
            di.pDocName = "ZPL Label";
            di.pDataType = "RAW";
            
            if (!StartDocPrinter(hPrinter, 1, di)) {
                return "StartDocPrinter failed: " + Marshal.GetLastWin32Error();
            }
            
            try {
                if (!StartPagePrinter(hPrinter)) {
                    return "StartPagePrinter failed: " + Marshal.GetLastWin32Error();
                }
                
                try {
                    IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
                    try {
                        Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);
                        int written;
                        if (!WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out written)) {
                            return "WritePrinter failed: " + Marshal.GetLastWin32Error();
                        }
                        if (written != bytes.Length) {
                            return "WritePrinter incomplete: wrote " + written + " of " + bytes.Length + " bytes";
                        }
                    } finally {
                        Marshal.FreeCoTaskMem(pUnmanagedBytes);
                    }
                } finally {
                    EndPagePrinter(hPrinter);
                }
            } finally {
                EndDocPrinter(hPrinter);
            }
        } finally {
            ClosePrinter(hPrinter);
        }
        
        return null; // Success
    }
}
"@
    
    Write-Host "[ZPL] Sending via RawPrinterHelper (winspool.Drv)..."
    $result = [RawPrinterHelper]::SendBytesToPrinter($printerName, $zplContent)
    
    if ($result -eq $null) {
        Write-Host "[ZPL] SUCCESS: ZPL sent via RawPrinterHelper ($($zplContent.Length) bytes)"
        exit 0
    } else {
        throw "RawPrinterHelper failed: $result"
    }
} catch {
    Write-Host "[ZPL] ERROR: $_"
    exit 1
}
`;
      
      const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
        windowsHide: true,
      });
      
      let stdout = '';
      let stderr = '';
      
      ps.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        console.log('[ZPL]', text.trim());
      });
      
      ps.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        console.error('[ZPL Error]', text.trim());
      });
      
      ps.on('close', (code) => {
        if (code === 0) {
          console.log('[Printer] ZPL raw print completed successfully');
          resolve();
        } else {
          const errorMsg = `ZPL raw print failed with exit code ${code}: ${stderr || stdout}`;
          console.error('[Printer]', errorMsg);
          reject(new Error(errorMsg));
        }
      });
      
      ps.on('error', (error) => {
        console.error('[Printer] Failed to start ZPL print process:', error);
        reject(error);
      });
    });
  }
  
  /**
   * Send ZPL to printer on macOS using lp with raw mode
   */
  private async printZplMac(filePath: string, printerName: string): Promise<void> {
    console.log('[Printer] ====== MAC ZPL RAW PRINT ======');
    console.log(`[Printer] Printer: "${printerName}"`);
    console.log(`[Printer] ZPL file: "${filePath}"`);
    
    // Use lp with -o raw option to send ZPL directly
    return new Promise((resolve, reject) => {
      const args = ['-d', printerName, '-o', 'raw', filePath];
      console.log(`[Printer] Executing: lp ${args.join(' ')}`);
      
      const process = spawn('lp', args);
      let stderr = '';
      
      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          console.log('[Printer] ZPL raw print completed successfully');
          resolve();
        } else {
          const errorMsg = `lp (raw) exited with code ${code}: ${stderr}`;
          console.error('[Printer]', errorMsg);
          reject(new Error(errorMsg));
        }
      });
      
      process.on('error', (error) => {
        console.error('[Printer] Failed to start lp process:', error);
        reject(error);
      });
    });
  }
  
  /**
   * Log detailed printer diagnostics via PowerShell
   */
  private async logPrinterDiagnostics(printerName: string): Promise<void> {
    console.log('[Printer] ────── Printer Diagnostics ──────');
    
    return new Promise((resolve) => {
      const psCommand = `
        $printer = '${printerName.replace(/'/g, "''")}'
        
        Write-Host "[DIAG] Checking printer: $printer"
        
        # Check if printer is valid
        Add-Type -AssemblyName System.Drawing
        $settings = New-Object System.Drawing.Printing.PrinterSettings
        $settings.PrinterName = $printer
        Write-Host "[DIAG] Printer Valid: $($settings.IsValid)"
        
        # Get WMI details
        try {
          $wmi = Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Name = '$($printer.Replace('\\', '\\\\'))'" -ErrorAction SilentlyContinue
          if ($wmi) {
            Write-Host "[DIAG] Status: $($wmi.Status)"
            Write-Host "[DIAG] State: $($wmi.PrinterState)"
            Write-Host "[DIAG] Port: $($wmi.PortName)"
            Write-Host "[DIAG] Driver: $($wmi.DriverName)"
            Write-Host "[DIAG] Offline: $($wmi.WorkOffline)"
          } else {
            Write-Host "[DIAG] WARNING: Could not get WMI info"
          }
        } catch {
          Write-Host "[DIAG] WMI Error: $_"
        }
        
        # List available printers
        Write-Host "[DIAG] Available printers:"
        $printers = [System.Drawing.Printing.PrinterSettings]::InstalledPrinters
        foreach ($p in $printers) {
          if ($p -eq $printer) {
            Write-Host "[DIAG]   * $p (SELECTED)"
          } else {
            Write-Host "[DIAG]   - $p"
          }
        }
      `;
      
      const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand], {
        shell: false,
        windowsHide: true,
      });
      
      proc.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (line.trim()) console.log('[Printer]', line.trim());
        }
      });
      
      proc.stderr.on('data', (data) => {
        console.error('[Printer/DIAG Error]', data.toString().trim());
      });
      
      proc.on('close', () => {
        console.log('[Printer] ────── End Diagnostics ──────');
        resolve();
      });
      
      // Don't wait forever for diagnostics
      setTimeout(() => {
        try { proc.kill(); } catch {}
        resolve();
      }, 5000);
    });
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
    console.log('[Printer] ====== WINDOWS PRINT DISPATCH ======');
    console.log(`[Printer] Printer name: "${printerName}"`);
    console.log(`[Printer] File path: "${filePath}"`);
    
    // Unified printing: Use SumatraPDF exclusively
    // All printers (industrial thermal and consumer) use the same SumatraPDF->driver conversion
    // This eliminates false success reports from fallback methods that don't work with thermal printers
    console.log('[Printer] Using SumatraPDF (unified print method)');
    await this.printWithSumatra(filePath, printerName);
    console.log('[Printer] SumatraPDF print succeeded!');
  }
  
  private async printWithSumatra(filePath: string, printerName: string): Promise<void> {
    let foundPath: string | null = null;
    
    // Check bundled SumatraPDF first (always preferred)
    if (this.bundledSumatraPath) {
      printerLogger.diagnostic(`Checking bundled SumatraPDF at: ${this.bundledSumatraPath}`);
      try {
        await fs.access(this.bundledSumatraPath);
        foundPath = this.bundledSumatraPath;
        printerLogger.diagnostic(`Found bundled SumatraPDF at: ${this.bundledSumatraPath}`);
      } catch {
        printerLogger.diagnostic('Bundled SumatraPDF not found, checking system paths...');
      }
    }
    
    // Fallback: Search for SumatraPDF in common installation paths
    if (!foundPath) {
      const sumatraPaths = [
        // Common installation locations
        'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
        'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
        // Local user installations
        `${process.env.LOCALAPPDATA}\\SumatraPDF\\SumatraPDF.exe`,
        `${process.env.APPDATA}\\SumatraPDF\\SumatraPDF.exe`,
        // Portable version in user's home folder
        `${process.env.USERPROFILE}\\SumatraPDF\\SumatraPDF.exe`,
        `${process.env.USERPROFILE}\\Downloads\\SumatraPDF.exe`,
        // If in PATH
        'SumatraPDF.exe',
      ];
      
      printerLogger.diagnostic('Searching for system SumatraPDF...', { searchPaths: sumatraPaths });
      
      for (const sumatraPath of sumatraPaths) {
        if (!sumatraPath) continue;
        try {
          await fs.access(sumatraPath);
          foundPath = sumatraPath;
          printerLogger.diagnostic(`Found system SumatraPDF at: ${sumatraPath}`);
          break;
        } catch {
          // Continue searching
        }
      }
    }
    
    if (!foundPath) {
      const errorMsg = 'SumatraPDF not found. The bundled version is missing and no system installation was found.';
      printerLogger.diagnostic(errorMsg);
      throw new Error(errorMsg);
    }
    
    return new Promise((resolve, reject) => {
      const args = ['-print-to', printerName, '-silent', filePath];
      
      // Log the exact command being executed - this is the key info the user wanted
      // Note: We don't have jobId/orderNumber in this context, they're logged at the higher level
      printerLogger.log('info', 'COMMAND_INVOKED', `Executing SumatraPDF`, {
        command: foundPath,
        args,
        printer: printerName,
        file: filePath,
        fullCommand: `"${foundPath}" ${args.map(a => `"${a}"`).join(' ')}`,
      });
      
      const proc = spawn(foundPath!, args, { shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => { 
        stdout += data.toString(); 
        printerLogger.diagnostic(`SumatraPDF stdout: ${data.toString().trim()}`);
      });
      proc.stderr.on('data', (data) => { 
        stderr += data.toString(); 
        printerLogger.diagnostic(`SumatraPDF stderr: ${data.toString().trim()}`);
      });
      proc.on('error', (error) => {
        printerLogger.diagnostic(`SumatraPDF spawn error: ${error.message}`);
        reject(error);
      });
      proc.on('close', (code) => {
        printerLogger.diagnostic(`SumatraPDF exited`, { exitCode: code, stdout, stderr });
        if (code === 0) {
          resolve();
        } else {
          const errorMsg = `SumatraPDF exited with code ${code}: ${stderr || stdout || 'No output'}`;
          reject(new Error(errorMsg));
        }
      });
    });
  }
  
  private printWithAdobeReader(filePath: string, printerName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Try common Adobe Reader paths
      const adobePaths = [
        'C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe',
        'C:\\Program Files (x86)\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe',
        'C:\\Program Files\\Adobe\\Reader 11.0\\Reader\\AcroRd32.exe',
        'AcroRd32.exe', // If in PATH
      ];
      
      // Use spawn to find and execute Adobe Reader
      // Adobe Reader syntax: AcroRd32.exe /t "file.pdf" "printer" "driver" "port"
      const psCommand = `
        $adobePaths = @(${adobePaths.map(p => `'${p.replace(/'/g, "''")}'`).join(',')})
        $found = $false
        foreach ($path in $adobePaths) {
          if (Test-Path $path) {
            $found = $true
            $proc = Start-Process -FilePath $path -ArgumentList '/t', '"${filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"', '"${printerName.replace(/"/g, '\\"')}"' -PassThru -WindowStyle Hidden
            Start-Sleep -Seconds 10
            if (!$proc.HasExited) { Stop-Process $proc -Force -ErrorAction SilentlyContinue }
            break
          }
        }
        if (!$found) { exit 1 }
      `;
      
      console.log('[Printer] Searching for Adobe Reader...');
      
      const proc = spawn('powershell', ['-NoProfile', '-Command', psCommand], {
        shell: false,
        windowsHide: true,
      });
      
      let stderr = '';
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.on('error', (error) => reject(error));
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Adobe Reader not found or failed: ${stderr}`));
        }
      });
    });
  }
  
  private printWithShellVerb(filePath: string, printerName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use Windows Shell to print via the default PDF handler
      // This requires a PDF viewer to be installed and associated with .pdf files
      const psCommand = `
        $file = '${filePath.replace(/'/g, "''")}'
        $printer = '${printerName.replace(/'/g, "''")}'
        
        Write-Host "[PowerShell] Printing $file to $printer"
        
        # Set the default printer temporarily
        $printerObj = Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Name = '$printer'"
        if ($printerObj) {
          $printerObj.SetDefaultPrinter() | Out-Null
          Write-Host "[PowerShell] Set default printer to: $printer"
        } else {
          Write-Host "[PowerShell] Warning: Could not find printer $printer in WMI"
        }
        
        # Print using shell verb
        $shell = New-Object -ComObject Shell.Application
        $folder = $shell.NameSpace((Split-Path $file))
        $item = $folder.ParseName((Split-Path $file -Leaf))
        
        if ($item) {
          $item.InvokeVerb('Print')
          Write-Host "[PowerShell] Print verb invoked"
          Start-Sleep -Seconds 5
        } else {
          Write-Error "Could not find file: $file"
          exit 1
        }
      `;
      
      console.log('[Printer] Executing shell print verb...');
      
      const proc = spawn('powershell', ['-NoProfile', '-Command', psCommand], {
        shell: false,
        windowsHide: true,
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log('[Printer/PS]', data.toString().trim());
      });
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error('[Printer/PS Error]', data.toString().trim());
      });
      
      proc.on('error', (error) => reject(error));
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Shell print failed (code ${code}): ${stderr || stdout}`));
        }
      });
    });
  }
  
  private printWithPowerShell(filePath: string, printerName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Last resort: read file content and send to printer
      // Note: This won't work well for PDFs but might work for some raw print scenarios
      const psCommand = `
        $file = '${filePath.replace(/'/g, "''")}'
        $printer = '${printerName.replace(/'/g, "''")}'
        
        Write-Host "[PowerShell] Attempting raw print to $printer"
        
        # For label printers, try sending raw data
        $content = [System.IO.File]::ReadAllBytes($file)
        
        # Use .NET printing
        Add-Type -AssemblyName System.Drawing
        $printDoc = New-Object System.Drawing.Printing.PrintDocument
        $printDoc.PrinterSettings.PrinterName = $printer
        
        if ($printDoc.PrinterSettings.IsValid) {
          Write-Host "[PowerShell] Printer is valid, attempting print..."
          # Note: This approach doesn't work for PDFs, but signals that we tried
          throw "PDF printing requires a PDF viewer application"
        } else {
          throw "Printer '$printer' is not valid or not accessible"
        }
      `;
      
      const proc = spawn('powershell', ['-NoProfile', '-Command', psCommand], {
        shell: false,
        windowsHide: true,
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log('[Printer/PS]', data.toString().trim());
      });
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      proc.on('error', (error) => reject(error));
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`PowerShell print failed: ${stderr || 'Unknown error'}`));
        }
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
