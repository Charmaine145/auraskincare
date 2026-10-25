import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CallSummary, TicketCategory, TicketStatus } from "@/types";

/**
 * The project had no database, so this is an additive, file-backed store for demo records:
 * post-call summaries, verified tool turns, support tickets and satisfaction feedback.
 *
 * It is deliberately small and dependency-free. Writes are serialised in-process and replace
 * the file atomically. On a read-only host (for example a serverless deployment without a
 * persistent volume) writes fail softly and the UI reports that nothing was saved; existing
 * order and chat behaviour is never affected. Set ARIA_DATA_DIR to point at a writable volume.
 */

export interface StoredTicket {
  reference: string;
  sid: string;
  brand: string;
  category: TicketCategory;
  status: TicketStatus;
  reason: string;
  order_id: string | null;
  created_at: number;
  updated_at: number;
  demo: true;
}

export interface StoredFeedback {
  id: string;
  sid: string;
  brand: string;
  rating: number;
  comment: string;
  created_at: number;
  demo: true;
}

export interface StoredConversation {
  id: string;
  sid: string;
  brand: string;
  channel: "voice" | "text";
  created_at: number;
  summary: CallSummary;
  data_source: "demo";
}

export interface StoredToolCall {
  name: string;
  status: string;
  ms: number;
}

export interface StoredTurn {
  id: string;
  sid: string;
  brand: string;
  at: number;
  mode: "ai" | "demo";
  ms: number;
  tool_calls: StoredToolCall[];
  guardrails: number;
  model_ms: number[];
  error: string | null;
}

export interface Database {
  version: 1;
  conversations: StoredConversation[];
  tickets: StoredTicket[];
  feedback: StoredFeedback[];
  turns: StoredTurn[];
}

const empty = (): Database => ({ version: 1, conversations: [], tickets: [], feedback: [], turns: [] });
const MAX_RECORDS = 5_000;

function dataFile(): string {
  const dir = process.env.ARIA_DATA_DIR?.trim() || path.join(process.cwd(), ".data");
  return path.join(dir, "aria-demo.json");
}

let queue: Promise<unknown> = Promise.resolve();
let warned = false;

function warnOnce(error: unknown) {
  if (warned) return;
  warned = true;
  console.warn("Aria demo store: records can't be saved on this host. Set ARIA_DATA_DIR to a writable directory.", error instanceof Error ? error.message : error);
}

async function readFile(): Promise<Database> {
  try {
    const raw = JSON.parse(await fs.readFile(dataFile(), "utf8")) as Partial<Database>;
    return {
      version: 1,
      conversations: Array.isArray(raw.conversations) ? raw.conversations : [],
      tickets: Array.isArray(raw.tickets) ? raw.tickets : [],
      feedback: Array.isArray(raw.feedback) ? raw.feedback : [],
      turns: Array.isArray(raw.turns) ? raw.turns : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) warnOnce(error);
    return empty();
  }
}

async function writeFile(db: Database): Promise<void> {
  const file = dataFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(db), "utf8");
  await fs.rename(temp, file);
}

function trim<T>(items: T[]): T[] {
  return items.length > MAX_RECORDS ? items.slice(items.length - MAX_RECORDS) : items;
}

/** Serialises every read-modify-write so two turns can't overwrite each other's records. */
function mutate<T>(work: (db: Database) => T): Promise<T> {
  const next = queue.then(async () => {
    const db = await readFile();
    const result = work(db);
    db.conversations = trim(db.conversations);
    db.tickets = trim(db.tickets);
    db.feedback = trim(db.feedback);
    db.turns = trim(db.turns);
    await writeFile(db);
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Snapshot for the protected admin view and analytics. Never throws. */
export async function readDatabase(): Promise<Database> {
  return readFile();
}

/** Best-effort analytics write: never breaks a call. */
export async function saveConversation(record: Omit<StoredConversation, "id" | "created_at" | "data_source"> & { created_at?: number }): Promise<boolean> {
  try {
    await mutate(db => {
      const sid = record.sid;
      if (db.conversations.some(item => item.sid === sid)) return;
      db.conversations.push({ ...record, id: randomUUID(), created_at: record.created_at ?? Date.now(), data_source: "demo" });
    });
    return true;
  } catch (error) {
    warnOnce(error);
    return false;
  }
}

/** Best-effort verified tool-turn write for analytics. */
export async function saveTurn(record: Omit<StoredTurn, "id" | "at"> & { at?: number }): Promise<boolean> {
  try {
    await mutate(db => {
      db.turns.push({ ...record, id: randomUUID(), at: record.at ?? Date.now() });
    });
    return true;
  } catch (error) {
    warnOnce(error);
    return false;
  }
}

/** Creates one ticket per escalation reference per call; retries are safe. */
export async function saveTicket(input: {
  reference: string;
  sid: string;
  brand: string;
  category: TicketCategory;
  reason: string;
  order_id: string | null;
  created_at?: number;
}): Promise<StoredTicket> {
  return mutate(db => {
    const existing = db.tickets.find(ticket => ticket.reference === input.reference && ticket.sid === input.sid);
    if (existing) return existing;
    const ticket: StoredTicket = {
      reference: input.reference,
      sid: input.sid,
      brand: input.brand,
      category: input.category,
      status: "Open",
      reason: input.reason.slice(0, 300),
      order_id: input.order_id,
      created_at: input.created_at ?? Date.now(),
      updated_at: Date.now(),
      demo: true,
    };
    db.tickets.push(ticket);
    return ticket;
  });
}

export async function getTicket(reference: string): Promise<StoredTicket | null> {
  const db = await readFile();
  return db.tickets.find(ticket => ticket.reference === reference) ?? null;
}

/** Deduplicated per call: submitting twice updates the same response instead of inflating CSAT. */
export async function saveFeedback(input: { sid: string; brand: string; rating: number; comment: string }): Promise<StoredFeedback> {
  return mutate(db => {
    const existing = db.feedback.find(item => item.sid === input.sid);
    if (existing) return existing;
    const feedback: StoredFeedback = { ...input, id: randomUUID(), created_at: Date.now(), demo: true };
    db.feedback.push(feedback);
    return feedback;
  });
}

export async function updateTicket(reference: string, status: TicketStatus): Promise<StoredTicket | null> {
  return mutate(db => {
    const ticket = db.tickets.find(item => item.reference === reference);
    if (!ticket) return null;
    ticket.status = status;
    ticket.updated_at = Date.now();
    return ticket;
  });
}
