import type { AgentEvent, ChatMessage } from "../src/types";
import os from "node:os";
import path from "node:path";

// Tests must never write demo records into the developer's real .data store.
process.env.ARIA_DATA_DIR ??= path.join(os.tmpdir(), `aria-tests-${process.pid}`);

/** Runs `fn` with temporary environment variables, restoring them afterwards. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Replaces fetch with a scripted fake that records every request body. */
export async function withFetch<T>(handler: (url: string, body: any, index: number) => Response | Promise<Response>, fn: (calls: { url: string; body: any }[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: any = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // Non-JSON bodies (e.g. SSML) are kept as text.
      }
    }
    calls.push({ url, body });
    return handler(url, body, calls.length - 1);
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** A Gemini generateContent response with the given parts. */
export const gemini = (...parts: Record<string, unknown>[]) => Response.json({ candidates: [{ content: { role: "model", parts } }] });
export const call = (name: string, args: Record<string, unknown>, id?: string) => ({ functionCall: { name, args, ...(id ? { id } : {}) }, thoughtSignature: "sig-123" });
export const text = (value: string) => ({ text: value });

/** Builds a conversation from alternating customer/Aria lines, starting with the customer. */
export function history(...lines: string[]): ChatMessage[] {
  return lines.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }));
}

export function collector() {
  const events: AgentEvent[] = [];
  return { events, emit: (event: AgentEvent) => events.push(event) };
}
