import { eq, desc, or, ilike, and } from "drizzle-orm";
import { db } from "./db";
import {
  type User,
  type InsertUser,
  users,
  type MagicLinkToken,
  type InsertMagicLinkToken,
  magicLinkTokens,
  type Session,
  type InsertSession,
  sessions,
  type Order,
  type InsertOrder,
  orders,
} from "@shared/schema";

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<InsertUser>): Promise<User | undefined>;

  // Magic Link Tokens
  createMagicLinkToken(token: InsertMagicLinkToken): Promise<MagicLinkToken>;
  getMagicLinkToken(token: string): Promise<MagicLinkToken | undefined>;
  deleteMagicLinkToken(token: string): Promise<void>;
  deleteExpiredTokens(): Promise<void>;

  // Sessions
  createSession(session: InsertSession): Promise<Session>;
  getSession(token: string): Promise<Session | undefined>;
  deleteSession(token: string): Promise<void>;
  deleteExpiredSessions(): Promise<void>;

  // Orders
  createOrder(order: InsertOrder): Promise<Order>;
  updateOrder(id: string, order: Partial<InsertOrder>): Promise<Order | undefined>;
  getOrder(id: string): Promise<Order | undefined>;
  searchOrders(query: string): Promise<Order[]>;
  getAllOrders(limit?: number): Promise<Order[]>;
}

export class DatabaseStorage implements IStorage {
  // Users
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.email, email));
    return result[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    const result = await db.insert(users).values(user).returning();
    return result[0];
  }

  async updateUser(id: string, updates: Partial<InsertUser>): Promise<User | undefined> {
    const result = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    return result[0];
  }

  // Magic Link Tokens
  async createMagicLinkToken(token: InsertMagicLinkToken): Promise<MagicLinkToken> {
    const result = await db.insert(magicLinkTokens).values(token).returning();
    return result[0];
  }

  async getMagicLinkToken(token: string): Promise<MagicLinkToken | undefined> {
    const result = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.token, token));
    return result[0];
  }

  async deleteMagicLinkToken(token: string): Promise<void> {
    await db.delete(magicLinkTokens).where(eq(magicLinkTokens.token, token));
  }

  async deleteExpiredTokens(): Promise<void> {
    await db
      .delete(magicLinkTokens)
      .where(eq(magicLinkTokens.expiresAt, new Date()));
  }

  // Sessions
  async createSession(session: InsertSession): Promise<Session> {
    const result = await db.insert(sessions).values(session).returning();
    return result[0];
  }

  async getSession(token: string): Promise<Session | undefined> {
    const result = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, token));
    return result[0];
  }

  async deleteSession(token: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.token, token));
  }

  async deleteExpiredSessions(): Promise<void> {
    await db.delete(sessions).where(eq(sessions.expiresAt, new Date()));
  }

  // Orders
  async createOrder(order: InsertOrder): Promise<Order> {
    const result = await db.insert(orders).values(order).returning();
    return result[0];
  }

  async updateOrder(id: string, orderUpdate: Partial<InsertOrder>): Promise<Order | undefined> {
    const result = await db
      .update(orders)
      .set(orderUpdate)
      .where(eq(orders.id, id))
      .returning();
    return result[0];
  }

  async getOrder(id: string): Promise<Order | undefined> {
    const result = await db.select().from(orders).where(eq(orders.id, id));
    return result[0];
  }

  async searchOrders(query: string): Promise<Order[]> {
    const searchPattern = `%${query}%`;
    const result = await db
      .select()
      .from(orders)
      .where(
        or(
          ilike(orders.customerName, searchPattern),
          ilike(orders.customerEmail, searchPattern),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(50);
    return result;
  }

  async getAllOrders(limit: number = 50): Promise<Order[]> {
    const result = await db
      .select()
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(limit);
    return result;
  }
}

export const storage = new DatabaseStorage();
