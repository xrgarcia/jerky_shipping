import https from 'https';
import http from 'http';
import { URL } from 'url';
import type { Station, StationSession, Printer, PrintJob, User } from '../shared/types';

async function httpRequest<T>(
  url: string,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    
    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : undefined);
            } catch {
              resolve(undefined as T);
            }
          } else {
            try {
              const error = JSON.parse(data);
              reject(new Error(error.error || `HTTP ${res.statusCode}`));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          }
        });
      }
    );
    
    req.on('error', reject);
    
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

export class ApiClient {
  private token: string;
  private baseUrl: string;
  
  constructor(token: string, baseUrl: string) {
    this.token = token;
    this.baseUrl = baseUrl;
  }
  
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    
    return httpRequest<T>(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  
  async getCurrentUser(): Promise<User> {
    return this.request<User>('GET', '/api/desktop/me');
  }
  
  async getStations(): Promise<Station[]> {
    return this.request<Station[]>('GET', '/api/desktop/stations');
  }
  
  async getStation(stationId: string): Promise<Station> {
    return this.request<Station>('GET', `/api/desktop/stations/${stationId}`);
  }
  
  async claimStation(stationId: string): Promise<StationSession> {
    return this.request<StationSession>('POST', `/api/desktop/stations/${stationId}/claim`);
  }
  
  async releaseStation(sessionId: string): Promise<void> {
    await this.request<void>('POST', `/api/desktop/sessions/${sessionId}/release`);
  }
  
  async getPrinters(stationId: string): Promise<Printer[]> {
    return this.request<Printer[]>('GET', `/api/desktop/stations/${stationId}/printers`);
  }
  
  async registerPrinter(data: {
    name: string;
    systemName: string;
    stationId: string;
  }): Promise<Printer> {
    return this.request<Printer>('POST', '/api/desktop/printers', data);
  }
  
  async updatePrinterStatus(printerId: string, status: string): Promise<void> {
    await this.request<void>('PATCH', `/api/desktop/printers/${printerId}`, { status });
  }
  
  async getPrintJobs(stationId: string): Promise<PrintJob[]> {
    return this.request<PrintJob[]>('GET', `/api/desktop/stations/${stationId}/jobs`);
  }
  
  async updateJobStatus(
    jobId: string,
    status: string,
    errorMessage?: string
  ): Promise<void> {
    await this.request<void>('PATCH', `/api/desktop/jobs/${jobId}`, {
      status,
      errorMessage,
    });
  }
}
