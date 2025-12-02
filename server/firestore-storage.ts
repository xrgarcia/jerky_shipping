import { initializeApp, cert, getApps, App } from 'firebase-admin/app';
import { getFirestore, Firestore, Timestamp, Query, DocumentSnapshot, DocumentData } from 'firebase-admin/firestore';
import type { SkuVaultOrderSession, SkuVaultOrderSessionFilters, SkuVaultOrderSessionItem } from '@shared/firestore-schema';

let firestoreDb: Firestore | null = null;
let firebaseApp: App | null = null;

const FIRESTORE_DATABASE_ID = 'jerky-data-hub';

function getFirestoreDb(): Firestore {
  if (firestoreDb) {
    return firestoreDb;
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJson) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set');
  }

  try {
    console.log('[FirestoreStorage] Parsing service account JSON...');
    const serviceAccount = JSON.parse(serviceAccountJson);
    
    console.log('[FirestoreStorage] Service account project_id:', serviceAccount.project_id);
    console.log('[FirestoreStorage] Using named database:', FIRESTORE_DATABASE_ID);
    
    // Check if Firebase app is already initialized
    const existingApps = getApps();
    if (existingApps.length === 0) {
      console.log('[FirestoreStorage] Initializing Firebase app...');
      firebaseApp = initializeApp({
        credential: cert(serviceAccount),
      });
    } else {
      firebaseApp = existingApps[0];
    }
    
    // Connect to the named database using the databaseId parameter
    firestoreDb = getFirestore(firebaseApp, FIRESTORE_DATABASE_ID);
    console.log('[FirestoreStorage] Firestore connection initialized successfully to database:', FIRESTORE_DATABASE_ID);
    return firestoreDb;
  } catch (error: any) {
    console.error('[FirestoreStorage] Failed to initialize Firestore:', error.message);
    console.error('[FirestoreStorage] Error stack:', error.stack);
    throw error;
  }
}

export interface IFirestoreStorage {
  getSkuVaultOrderSessions(filters: SkuVaultOrderSessionFilters): Promise<{
    sessions: SkuVaultOrderSession[];
    total: number;
  }>;
  getSkuVaultOrderSessionByPicklistId(picklistId: string): Promise<SkuVaultOrderSession[]>;
  getUniquePickerNames(): Promise<string[]>;
  getUniqueSessionStatuses(): Promise<string[]>;
  getSessionsUpdatedSince(sinceDate: Date, limit?: number): Promise<SkuVaultOrderSession[]>;
  getTodaysSessions(): Promise<SkuVaultOrderSession[]>;
  getNonClosedSessions(): Promise<SkuVaultOrderSession[]>;
}

export class FirestoreStorage implements IFirestoreStorage {
  private readonly collectionName = 'skuvaultOrderSessions';

  private convertTimestamp(timestamp: Timestamp | Date | null): Date | null {
    if (!timestamp) return null;
    if (timestamp instanceof Timestamp) {
      return timestamp.toDate();
    }
    return timestamp as Date;
  }

  private mapDocToSession(doc: DocumentSnapshot<DocumentData>): SkuVaultOrderSession {
    const data = doc.data();
    if (!data) {
      throw new Error(`Document ${doc.id} has no data`);
    }

    return {
      document_id: doc.id,
      order_number: data.order_number || '',
      session_id: data.session_id || 0,
      shipment_id: data.shipment_id || '',
      sale_id: data.sale_id || '',
      session_picklist_id: data.session_picklist_id || '',
      session_status: data.session_status || '',
      spot_number: data.spot_number || 0,
      picked_by_user_id: data.picked_by_user_id || 0,
      picked_by_user_name: data.picked_by_user_name || '',
      pick_start_datetime: this.convertTimestamp(data.pick_start_datetime) || new Date(),
      pick_end_datetime: this.convertTimestamp(data.pick_end_datetime) || new Date(),
      create_date: this.convertTimestamp(data.create_date) || new Date(),
      updated_date: this.convertTimestamp(data.updated_date) || new Date(),
      saved_custom_field_2: data.saved_custom_field_2 || false,
      order_items: (data.order_items || []).map((item: any): SkuVaultOrderSessionItem => ({
        audit_status: item.audit_status ?? null,
        available: item.available ?? null,
        code: item.code ?? null,
        completed: item.completed ?? null,
        description: item.description ?? null,
        is_serialized: item.is_serialized ?? null,
        location: item.location ?? null,
        locations: item.locations ?? null,
        not_found_product: item.not_found_product ?? null,
        part_number: item.part_number ?? null,
        picked: item.picked ?? null,
        product_id: item.product_id ?? null,
        product_pictures: item.product_pictures ?? null,
        quantity: item.quantity || 0,
        sku: item.sku || '',
        stock_status: item.stock_status ?? null,
        weight_pound: item.weight_pound ?? null,
      })),
    };
  }

  async getSkuVaultOrderSessions(filters: SkuVaultOrderSessionFilters): Promise<{
    sessions: SkuVaultOrderSession[];
    total: number;
  }> {
    const db = getFirestoreDb();
    let query: Query<DocumentData> = db.collection(this.collectionName);

    // Apply date filters if provided
    if (filters.startDate) {
      const startDate = new Date(filters.startDate);
      startDate.setHours(0, 0, 0, 0);
      query = query.where('create_date', '>=', Timestamp.fromDate(startDate));
    }

    if (filters.endDate) {
      const endDate = new Date(filters.endDate);
      endDate.setHours(23, 59, 59, 999);
      query = query.where('create_date', '<=', Timestamp.fromDate(endDate));
    }

    // Apply picker name filter
    if (filters.pickerName) {
      query = query.where('picked_by_user_name', '==', filters.pickerName);
    }

    // Apply session status filter
    if (filters.sessionStatus) {
      query = query.where('session_status', '==', filters.sessionStatus);
    }

    // Order by create_date descending (most recent first)
    query = query.orderBy('create_date', 'desc');

    // Execute the query
    const snapshot = await query.get();
    let sessions = snapshot.docs.map(doc => this.mapDocToSession(doc));

    // Apply text search filter (client-side for Firestore)
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      sessions = sessions.filter(session => 
        session.order_number.toLowerCase().includes(searchLower) ||
        session.session_id.toString().includes(searchLower) ||
        session.shipment_id.toLowerCase().includes(searchLower) ||
        session.picked_by_user_name.toLowerCase().includes(searchLower) ||
        session.sale_id.toLowerCase().includes(searchLower) ||
        session.session_picklist_id.toLowerCase().includes(searchLower) ||
        session.spot_number.toString().includes(searchLower)
      );
    }

    const total = sessions.length;

    // Apply pagination
    const offset = filters.offset || 0;
    const limit = filters.limit || 50;
    sessions = sessions.slice(offset, offset + limit);

    return { sessions, total };
  }

  async getSkuVaultOrderSessionByPicklistId(picklistId: string): Promise<SkuVaultOrderSession[]> {
    const db = getFirestoreDb();
    
    // The picklistId from customField2 is the numeric session_id
    const numericId = parseInt(picklistId, 10);
    
    if (!isNaN(numericId)) {
      // Query by session_id (numeric) - this is the primary identifier
      // Note: Avoid combining where + orderBy on different fields to prevent composite index requirements
      const snapshot = await db.collection(this.collectionName)
        .where('session_id', '==', numericId)
        .get();
      
      if (!snapshot.empty) {
        const sessions = snapshot.docs.map(doc => this.mapDocToSession(doc));
        // Sort in memory by create_date descending
        return sessions.sort((a, b) => 
          new Date(b.create_date).getTime() - new Date(a.create_date).getTime()
        );
      }
    }
    
    // Fallback: try querying by session_picklist_id as a string
    const stringSnapshot = await db.collection(this.collectionName)
      .where('session_picklist_id', '==', picklistId)
      .get();
    
    if (!stringSnapshot.empty) {
      const sessions = stringSnapshot.docs.map(doc => this.mapDocToSession(doc));
      return sessions.sort((a, b) => 
        new Date(b.create_date).getTime() - new Date(a.create_date).getTime()
      );
    }

    return [];
  }

  async getUniquePickerNames(): Promise<string[]> {
    const db = getFirestoreDb();
    const snapshot = await db.collection(this.collectionName)
      .orderBy('create_date', 'desc')
      .limit(500)
      .get();

    const pickerNames = new Set<string>();
    snapshot.docs.forEach(doc => {
      const data = doc.data();
      if (data.picked_by_user_name) {
        pickerNames.add(data.picked_by_user_name);
      }
    });

    return Array.from(pickerNames).sort();
  }

  async getUniqueSessionStatuses(): Promise<string[]> {
    const db = getFirestoreDb();
    const snapshot = await db.collection(this.collectionName)
      .orderBy('create_date', 'desc')
      .limit(500)
      .get();

    const statuses = new Set<string>();
    snapshot.docs.forEach(doc => {
      const data = doc.data();
      if (data.session_status) {
        statuses.add(data.session_status);
      }
    });

    return Array.from(statuses).sort();
  }

  /**
   * Get sessions updated since a given timestamp for incremental sync
   * Used by the session sync worker to fetch recently updated sessions
   */
  async getSessionsUpdatedSince(sinceDate: Date, limit: number = 500): Promise<SkuVaultOrderSession[]> {
    const db = getFirestoreDb();
    
    // Query for sessions updated after the given date
    const snapshot = await db.collection(this.collectionName)
      .where('updated_date', '>', Timestamp.fromDate(sinceDate))
      .orderBy('updated_date', 'asc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => this.mapDocToSession(doc));
  }

  /**
   * Get all sessions created today (for initial sync and daily metrics)
   */
  async getTodaysSessions(): Promise<SkuVaultOrderSession[]> {
    const db = getFirestoreDb();
    
    // Start of today in UTC
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    
    const snapshot = await db.collection(this.collectionName)
      .where('create_date', '>=', Timestamp.fromDate(today))
      .orderBy('create_date', 'desc')
      .get();

    return snapshot.docs.map(doc => this.mapDocToSession(doc));
  }

  /**
   * Get all non-closed sessions (new, active, inactive)
   * Used by sync worker to reliably catch all status changes
   * Firestore doesn't support != queries, so we query each status separately
   */
  async getNonClosedSessions(): Promise<SkuVaultOrderSession[]> {
    const db = getFirestoreDb();
    const nonClosedStatuses = ['new', 'active', 'inactive'];
    const allSessions: SkuVaultOrderSession[] = [];

    for (const status of nonClosedStatuses) {
      const snapshot = await db.collection(this.collectionName)
        .where('session_status', '==', status)
        .get();
      
      for (const doc of snapshot.docs) {
        allSessions.push(this.mapDocToSession(doc));
      }
    }

    console.log(`[FirestoreStorage] Found ${allSessions.length} non-closed sessions (${nonClosedStatuses.join(', ')})`);
    return allSessions;
  }
}

export const firestoreStorage = new FirestoreStorage();
