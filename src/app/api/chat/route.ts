import { z } from "zod";
import { runTurn } from "@/lib/agent/agent";
import { getProvider } from "@/lib/agent/providers";
import { checkRateLimit } from "@/lib/rateLimit";
import { BRAND_IDS, type BrandId } from "@/data/brand";
import { readSession, signSession } from "@/lib/session";
import { saveTurn, type StoredToolCall } from "@/lib/store";
import { persistEscalations } from "@/lib/tickets";
import { historySchema, readBody, sessionTokenSchema } from "@/lib/validation";
import type { ChatStreamEvent } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  messages: historySchema,
  session: sessionTokenSchema,
  language: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).optional(),
  // The brand a new call is for; a call in progress stays with the brand in its signed session.
  brand: z.enum(BRAND_IDS as [BrandId, ...BrandId[]]).optional(),
}).strict();

/**
 * Runs one customer turn and streams newline-delimited JSON events:
 * tool calls and guardrails as they happen, then the reply, then the new signed session.
 */
export async function POST(request: Request) {
  if (!checkRateLimit(request, "chat")) {
    return Response.json({ error: "This demo has reached its hourly limit for your network. Please try again later." }, { status: 429 });
  }

  let input: z.infer<typeof bodySchema>;
  let session: ReturnType<typeof readSession>;
  try {
    input = bodySchema.parse(await readBody(request));
    session = readSession(input.session, input.brand);
  } catch (error) {
    const message = error instanceof z.ZodError || error instanceof SyntaxError ? "Invalid request. Please try a shorter message." : error instanceof Error ? error.message : "Invalid request.";
    return Response.json({ error: message }, { status: 400 });
  }
  if (input.messages.at(-1)?.role !== "user") return Response.json({ error: "A customer message is required." }, { status: 400 });

  const mode = getProvider() ? "ai" : "demo";
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const calls = new Map<string, StoredToolCall>();
      let guardrails = 0;
      const modelMs: number[] = [];
      const send = (event: ChatStreamEvent) => {
        // Keep the verified server-side facts for analytics, never the model's wording.
        if (event.type === "tool_call") calls.set(event.id, { name: event.name, status: "running", ms: 0 });
        else if (event.type === "tool_result") calls.set(event.id, { name: event.name, status: event.status, ms: event.ms });
        else if (event.type === "guardrail") guardrails++;
        else if (event.type === "model") modelMs.push(event.ms);
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The caller hung up; nothing left to deliver.
        }
      };
      const started = performance.now();
      let failure: string | null = null;
      try {
        const result = await runTurn(input.messages, session, send, request.signal, input.language);
        const tickets = await persistEscalations(session);
        send({ type: "reply", text: result.reply, source: result.source });
        send({ type: "done", session: signSession(session), mode, cancelled: session.cancelled, endCall: result.endCall, ms: Math.round(performance.now() - started), tickets });
      } catch (error) {
        // No "done" event: the browser keeps its previous session, so a failed turn changes nothing.
        failure = error instanceof Error && error.name !== "AbortError" && error.name !== "TimeoutError" ? error.message : "The request took too long. Please try again.";
        send({ type: "error", message: failure });
      } finally {
        await saveTurn({
          sid: session.sid ?? "unknown-call",
          brand: session.brand ?? "aura",
          mode,
          ms: Math.round(performance.now() - started),
          tool_calls: [...calls.values()],
          guardrails,
          model_ms: modelMs,
          error: failure,
        });
      }
      try {
        controller.close();
      } catch {
        // Already closed by a disconnect.
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  });
}
