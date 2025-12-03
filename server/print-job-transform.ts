interface PrintJobPayload {
  orderNumber?: string;
  labelUrl?: string;
  labelData?: string | null;
  trackingNumber?: string;
  requestedBy?: string;
  printerName?: string;  // Printer name for display
}

export interface TransformedPrintJob {
  id: string;
  stationId: string;
  printerId: string | null;
  shipmentId: string | null;
  orderNumber: string;
  labelUrl: string | null;
  labelData: string | null;
  printerName: string | null;  // Printer name for display
  status: string;
  errorMessage: string | null;
  attempts: number;
  createdAt: string | Date;
  printedAt: string | Date | null;
  requestedBy: string | null;
}

export function transformPrintJobForDesktop(job: any): TransformedPrintJob {
  const payload = job.payload as PrintJobPayload | null;
  return {
    id: job.id,
    stationId: job.stationId,
    printerId: job.printerId,
    shipmentId: job.shipmentId,
    orderNumber: payload?.orderNumber || job.orderId || 'Unknown',
    labelUrl: payload?.labelUrl || null,
    labelData: payload?.labelData || null,
    printerName: payload?.printerName || null,
    status: job.status,
    errorMessage: job.errorMessage,
    attempts: job.attempts,
    createdAt: job.createdAt,
    printedAt: job.completedAt,
    requestedBy: payload?.requestedBy || null,
  };
}
