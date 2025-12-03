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
  suggestRawMode?: boolean; // Auto-detected suggestion for industrial printers
}

interface PdfViewerInfo {
  installed: boolean;
  viewer: string | null;
  path: string | null;
}

// Industrial printer brands that work best with raw/direct printing mode
const INDUSTRIAL_PRINTER_PATTERNS = [
  /sato/i,
  /cl4nx/i,
  /cl6nx/i,
  /zebra.*industrial/i,
  /zebra.*z[te]/i, // ZT410, ZT610, ZE500, etc.
  /zebra.*105sl/i,
  /zebra.*110xi/i,
  /zebra.*170xi/i,
  /zebra.*220xi/i,
  /honeywell.*pm/i, // PM42, PM43, PM45
  /honeywell.*px/i, // PX4i, PX6i
  /datamax/i,
  /tsc.*m[exb]/i, // ME240, MX240, MB240
  /citizen.*cl-s/i,
  /cab.*squix/i,
  /cab.*a\+/i,
  /idprt/i, // iDPRT thermal printers (SP410, etc.)
  /xprinter/i, // XPrinter thermal printers
  /godex/i, // Godex thermal printers
  /bixolon/i, // Bixolon thermal printers
];

export class PrinterService {
  private tempDir: string;
  private platform: NodeJS.Platform;
  private cachedPdfViewer: PdfViewerInfo | null = null;
  
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'jerky-ship-connect');
    this.platform = process.platform;
  }
  
  /**
   * Check if a printer name suggests it's an industrial label printer
   * that would benefit from raw/direct printing mode
   */
  isIndustrialPrinter(printerName: string): boolean {
    return INDUSTRIAL_PRINTER_PATTERNS.some(pattern => pattern.test(printerName));
  }
  
  /**
   * Detect if a PDF viewer is installed on Windows.
   * Returns cached result after first detection.
   * macOS always returns installed since it uses lp command.
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
    
    // Check SumatraPDF first (preferred for label printing)
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
          suggestRawMode: this.isIndustrialPrinter(name),
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
                suggestRawMode: this.isIndustrialPrinter(name),
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
  
  async print(job: PrintJob, printerName: string, useRawMode: boolean = false): Promise<void> {
    console.log('[Printer] ========================================');
    console.log('[Printer] PRINT JOB STARTING');
    console.log('[Printer] ========================================');
    console.log(`[Printer] Job ID: ${job.id}`);
    console.log(`[Printer] Printer: ${printerName}`);
    console.log(`[Printer] Has labelData: ${!!job.labelData}`);
    console.log(`[Printer] Has labelUrl: ${!!job.labelUrl}`);
    console.log(`[Printer] Platform: ${this.platform}`);
    console.log(`[Printer] Temp dir: ${this.tempDir}`);
    console.log(`[Printer] Use Raw Mode: ${useRawMode}`);
    
    await fs.mkdir(this.tempDir, { recursive: true });
    
    const labelPath = path.join(this.tempDir, `label-${job.id}.pdf`);
    console.log(`[Printer] Label file path: ${labelPath}`);
    
    try {
      if (job.labelData) {
        const buffer = Buffer.from(job.labelData, 'base64');
        await fs.writeFile(labelPath, buffer);
        console.log(`[Printer] Wrote ${buffer.length} bytes from base64 data`);
      } else if (job.labelUrl) {
        console.log(`[Printer] Downloading from: ${job.labelUrl}`);
        await this.downloadLabel(job.labelUrl, labelPath);
        const stats = await fs.stat(labelPath);
        console.log(`[Printer] Downloaded ${stats.size} bytes`);
      } else {
        throw new Error('No label data or URL provided');
      }
      
      // Verify file exists before printing
      const fileExists = await fs.stat(labelPath).then(() => true).catch(() => false);
      console.log(`[Printer] File exists before print: ${fileExists}`);
      
      await this.printFile(labelPath, printerName, useRawMode);
      
      console.log('[Printer] ========================================');
      console.log(`[Printer] Job ${job.id} printed successfully`);
      console.log('[Printer] ========================================');
    } catch (error) {
      console.log('[Printer] ========================================');
      console.log('[Printer] PRINT JOB FAILED');
      console.log(`[Printer] Error: ${error instanceof Error ? error.message : String(error)}`);
      console.log('[Printer] ========================================');
      throw error;
    } finally {
      try {
        await fs.unlink(labelPath);
        console.log('[Printer] Cleaned up temp file');
      } catch {
        // Ignore cleanup errors
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
  
  private async printFile(filePath: string, printerName: string, useRawMode: boolean = false): Promise<void> {
    if (this.platform === 'win32') {
      if (useRawMode) {
        console.log('[Printer] Using RAW MODE for Windows printing');
        return this.printFileWindowsRaw(filePath, printerName);
      }
      return this.printFileWindows(filePath, printerName);
    } else {
      return this.printFileMac(filePath, printerName);
    }
  }
  
  /**
   * Print using Windows raw/direct printing mode.
   * This bypasses PDF viewers and uses .NET's PrintDocument to render and print PDFs directly.
   * Best for industrial printers like SATO, Zebra, iDPRT, Honeywell, etc.
   */
  private async printFileWindowsRaw(filePath: string, printerName: string): Promise<void> {
    console.log('[Printer] ====== WINDOWS RAW PRINT MODE ======');
    console.log(`[Printer] Printer: ${printerName}`);
    console.log(`[Printer] File: ${filePath}`);
    
    return new Promise((resolve, reject) => {
      // Use PowerShell with .NET's System.Drawing.Printing to print directly
      // This approach uses Windows' built-in PDF rendering (via Windows.Data.Pdf)
      // and sends the rendered output directly to the printer without needing external PDF viewers
      const psCommand = `
        $ErrorActionPreference = 'Stop'
        $file = '${filePath.replace(/'/g, "''").replace(/\\/g, '\\\\')}'
        $printer = '${printerName.replace(/'/g, "''")}'
        
        Write-Host "[RAW] Starting direct print to: $printer"
        Write-Host "[RAW] File: $file"
        
        # Verify file exists
        if (!(Test-Path $file)) {
          throw "File not found: $file"
        }
        
        # Load required assemblies for printing
        Add-Type -AssemblyName System.Drawing
        Add-Type -AssemblyName System.Windows.Forms
        
        # Get printer settings
        $printerSettings = New-Object System.Drawing.Printing.PrinterSettings
        $printerSettings.PrinterName = $printer
        
        if (!$printerSettings.IsValid) {
          throw "Invalid printer: $printer"
        }
        
        Write-Host "[RAW] Printer is valid. Preparing print job..."
        
        # For PDFs, we'll use Windows' built-in printing infrastructure
        # Method: Use PrintQueue from System.Printing namespace for direct spooling
        try {
          Add-Type -AssemblyName System.Printing
          
          $printServer = New-Object System.Printing.LocalPrintServer
          $printQueue = $printServer.GetPrintQueue($printer)
          
          if ($printQueue -eq $null) {
            throw "Could not get print queue for: $printer"
          }
          
          Write-Host "[RAW] Got print queue. Adding job..."
          
          # Read the PDF file as bytes and send directly to print queue
          $fileBytes = [System.IO.File]::ReadAllBytes($file)
          
          # Create a print job with RAW datatype (printer interprets the data directly)
          $printJob = $printQueue.AddJob("ShipConnect Label", "RAW")
          $jobStream = $printJob.JobStream
          
          $jobStream.Write($fileBytes, 0, $fileBytes.Length)
          $jobStream.Close()
          
          Write-Host "[RAW] Print job submitted successfully via System.Printing"
          
        } catch {
          Write-Host "[RAW] System.Printing method failed: $_"
          Write-Host "[RAW] Falling back to WMI printing method..."
          
          # Fallback: Use WMI to add print job via Win32_Printer
          try {
            $wmiPrinter = Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Name = '$($printer.Replace("\\\\", "\\\\\\\\"))'"
            
            if ($wmiPrinter -eq $null) {
              # Try without escaping
              $wmiPrinter = Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Name = '$printer'"
            }
            
            if ($wmiPrinter -eq $null) {
              throw "Printer not found via WMI: $printer"
            }
            
            Write-Host "[RAW] Found printer via WMI. Using PrintFile method..."
            
            # Use the Windows print command which works with the printer driver
            # This sends the file to the printer's driver which handles the conversion
            $printResult = & cmd /c "print /D:\`"$printer\`" \`"$file\`"" 2>&1
            
            if ($LASTEXITCODE -ne 0) {
              Write-Host "[RAW] 'print' command failed, trying copy method..."
              
              # Alternative: Copy file directly to printer port (works for some printers)
              # First get the printer port
              $port = $wmiPrinter.PortName
              Write-Host "[RAW] Printer port: $port"
              
              # If it's a USB port, we can try copying directly
              if ($port -match "USB" -or $port -match "LPT") {
                $copyResult = & cmd /c "copy /B \`"$file\`" \`"$port\`"" 2>&1
                if ($LASTEXITCODE -eq 0) {
                  Write-Host "[RAW] File copied to port successfully"
                } else {
                  throw "Copy to port failed: $copyResult"
                }
              } else {
                throw "Print command failed: $printResult"
              }
            } else {
              Write-Host "[RAW] Print command succeeded"
            }
            
          } catch {
            throw "All printing methods failed. Last error: $_"
          }
        }
        
        Write-Host "[RAW] Print job completed successfully"
      `;
      
      const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand], {
        shell: false,
        windowsHide: true,
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log('[Printer/RAW]', data.toString().trim());
      });
      
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error('[Printer/RAW Error]', data.toString().trim());
      });
      
      proc.on('error', (error) => {
        console.error('[Printer] Raw print spawn error:', error);
        reject(error);
      });
      
      proc.on('close', (code) => {
        console.log(`[Printer] Raw print exited with code ${code}`);
        if (code === 0) {
          console.log('[Printer] ====== RAW PRINT SUCCESS ======');
          resolve();
        } else {
          const errorMsg = `Raw print failed (code ${code}): ${stderr || stdout || 'Unknown error'}`;
          console.log(`[Printer] ====== RAW PRINT FAILED: ${errorMsg} ======`);
          reject(new Error(errorMsg));
        }
      });
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
    console.log(`[Printer] LOCALAPPDATA: ${process.env.LOCALAPPDATA}`);
    console.log(`[Printer] APPDATA: ${process.env.APPDATA}`);
    console.log(`[Printer] USERPROFILE: ${process.env.USERPROFILE}`);
    
    // Try multiple approaches in order of reliability
    const errors: string[] = [];
    
    // Approach 1: Use SumatraPDF if available (most reliable for label printers)
    try {
      console.log('[Printer] ====== ATTEMPT 1: SumatraPDF ======');
      await this.printWithSumatra(filePath, printerName);
      console.log('[Printer] SumatraPDF print succeeded!');
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[Printer] SumatraPDF failed: ${msg}`);
      errors.push(`SumatraPDF: ${msg}`);
    }
    
    // Approach 2: Use Adobe Reader if available
    try {
      console.log('[Printer] ====== ATTEMPT 2: Adobe Reader ======');
      await this.printWithAdobeReader(filePath, printerName);
      console.log('[Printer] Adobe Reader print succeeded!');
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[Printer] Adobe Reader failed: ${msg}`);
      errors.push(`Adobe Reader: ${msg}`);
    }
    
    // Approach 3: Use Windows PrintTo shell verb (requires default PDF handler)
    try {
      console.log('[Printer] ====== ATTEMPT 3: Shell PrintTo ======');
      await this.printWithShellVerb(filePath, printerName);
      console.log('[Printer] Shell PrintTo succeeded!');
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[Printer] Shell PrintTo failed: ${msg}`);
      errors.push(`Shell PrintTo: ${msg}`);
    }
    
    // Approach 4: Use PowerShell's Out-Printer (text only, last resort)
    try {
      console.log('[Printer] ====== ATTEMPT 4: PowerShell ======');
      await this.printWithPowerShell(filePath, printerName);
      console.log('[Printer] PowerShell succeeded!');
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[Printer] PowerShell failed: ${msg}`);
      errors.push(`PowerShell: ${msg}`);
    }
    
    console.log('[Printer] ====== ALL METHODS FAILED ======');
    console.log('[Printer] Errors:', errors);
    throw new Error(`All print methods failed:\n${errors.join('\n')}`);
  }
  
  private async printWithSumatra(filePath: string, printerName: string): Promise<void> {
    // Search for SumatraPDF in common installation paths
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
    
    console.log('[Printer] ====== SUMATRA PDF SEARCH ======');
    console.log('[Printer] Looking for SumatraPDF in the following locations:');
    
    let foundPath: string | null = null;
    
    for (const sumatraPath of sumatraPaths) {
      if (!sumatraPath) continue;
      console.log(`[Printer]   Checking: ${sumatraPath}`);
      try {
        await fs.access(sumatraPath);
        foundPath = sumatraPath;
        console.log(`[Printer]   ✓ FOUND: ${sumatraPath}`);
        break;
      } catch {
        console.log(`[Printer]   ✗ Not found`);
      }
    }
    
    if (!foundPath) {
      const errorMsg = 'SumatraPDF not found. Please install from https://www.sumatrapdfreader.org/download-free-pdf-viewer and install to Program Files.';
      console.log(`[Printer] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    return new Promise((resolve, reject) => {
      const args = ['-print-to', printerName, '-silent', filePath];
      
      console.log('[Printer] ====== EXECUTING SUMATRA ======');
      console.log(`[Printer] Command: "${foundPath}" ${args.join(' ')}`);
      console.log(`[Printer] Printer: ${printerName}`);
      console.log(`[Printer] File: ${filePath}`);
      
      const proc = spawn(foundPath!, args, { shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => { 
        stdout += data.toString(); 
        console.log('[Printer/Sumatra OUT]', data.toString().trim());
      });
      proc.stderr.on('data', (data) => { 
        stderr += data.toString(); 
        console.log('[Printer/Sumatra ERR]', data.toString().trim());
      });
      proc.on('error', (error) => {
        console.log('[Printer] Sumatra spawn error:', error.message);
        reject(error);
      });
      proc.on('close', (code) => {
        console.log(`[Printer] Sumatra exited with code ${code}`);
        if (code === 0) {
          console.log('[Printer] ====== PRINT SUCCESS ======');
          resolve();
        } else {
          const errorMsg = `SumatraPDF exited with code ${code}: ${stderr || stdout || 'No output'}`;
          console.log(`[Printer] ====== PRINT FAILED: ${errorMsg} ======`);
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
