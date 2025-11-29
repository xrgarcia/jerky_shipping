interface PrintJobPayload {
  orderNumber?: string;
  labelUrl?: string;
  trackingNumber?: string;
  requestedBy?: string;
}

export interface TransformedPrintJob {
  id: string;
  stationId: string;
  printerId: string | null;
  shipmentId: string | null;
  orderNumber: string;
  labelUrl: string | null;
  labelData: null;
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
    labelData: null,
    status: job.status,
    errorMessage: job.errorMessage,
    attempts: job.attempts,
    createdAt: job.createdAt,
    printedAt: job.completedAt,
    requestedBy: payload?.requestedBy || null,
  };
}
