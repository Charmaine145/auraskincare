import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { brandById, DEFAULT_BRAND, type Brand, type BrandId } from "@/data/brand";
import type { SessionData } from "@/types";

/**
 * Per-call state lives in an HMAC-signed token that the browser sends back each turn.
 * The server stays stateless (works across serverless instances), each evaluator's call
 * is isolated, and the browser cannot forge a cancellation or an outcome.
 */

const scope = globalThis as typeof globalThis & { ariaSecret?: string };

/**
 * Every server instance must sign with the same secret: on Vercel, one call's turns can reach
 * different instances. SESSION_SECRET is best; without it, a secret is derived from the private
 * provider key, which all instances share. Only keyless local development gets a per-process one.
 */
function sessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const key = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
  if (key) return createHash("sha256").update(`aria-session:${key}`).digest("hex");
  if (process.env.VERCEL) console.warn("SESSION_SECRET is not set, so calls can fail when they reach another server instance. Set it in the Vercel project settings.");
  return (scope.ariaSecret ??= randomBytes(32).toString("hex"));
}

const secret = sessionSecret();
const CALL_TTL_MS = 60 * 60 * 1000;

export function newSession(brand: BrandId = DEFAULT_BRAND): SessionData {
  return { v: 2, expires: Date.now() + CALL_TTL_MS, sid: randomUUID(), startedAt: Date.now(), brand, cancelled: [], outcomes: [], escalations: [], toolCalls: 0 };
}

/** The brand a call is bound to: its orders and its policy numbers. */
export const sessionBrand = (session: SessionData): Brand => brandById(session.brand);

const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest();

/** Short signature attached to a ticket reference so a guessed reference can't read a ticket. */
export function ticketToken(reference: string): string {
  return sign(`ticket:${reference}`).toString("base64url").slice(0, 16);
}

export function verifyTicketToken(reference: string, token: string): boolean {
  const expected = Buffer.from(ticketToken(reference));
  const actual = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function signSession(data: SessionData): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${sign(payload).toString("base64url")}`;
}

/** A new call gets `brand`; an existing call keeps the brand it started with (a mismatch is refused). */
export function readSession(token?: string, brand?: BrandId): SessionData {
  if (!token) return newSession(brand);
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("Invalid call session. Please start a new call.");
  const expected = sign(payload);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid call session. Please start a new call.");
  const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as SessionData;
  if (data.v !== 2) throw new Error("This call was started by an older version. Please start a new call.");
  if (data.expires < Date.now()) throw new Error("This call session has expired. Please start a new call.");
  if (brand && brandById(data.brand).id !== brand) throw new Error("This call belongs to a different brand. Please start a new call.");
  return data;
}
