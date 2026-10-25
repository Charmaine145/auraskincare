import { z } from "zod";
import { getProvider } from "@/lib/agent/providers";
import { checkRateLimit } from "@/lib/rateLimit";
import { readSession } from "@/lib/session";
import { saveConversation } from "@/lib/store";
import { callSummarySchema, modelSummary, rulesSummary, type SummaryInput } from "@/lib/summary";
import { messageSchema, readBody, sessionTokenSchema } from "@/lib/validation";
import type { CallSummary } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const bodySchema = z.object({
  session: sessionTokenSchema,
  transcript: z.array(messageSchema).max(200),
  channel: z.enum(["voice", "text"]).optional(),
  metrics: z.object({ duration_seconds: z.number().int().min(0).max(86_400).nullable(), avg_response_ms: z.number().int().min(0).max(120_000).nullable() }).partial().optional(),
}).strict();

export async function POST(request: Request) {
  let input: SummaryInput;
  let channel: "voice" | "text";
  try {
    const body = bodySchema.parse(await readBody(request));
    input = {
      session: readSession(body.session),
      transcript: body.transcript,
      durationSeconds: body.metrics?.duration_seconds ?? null,
      avgResponseMs: body.metrics?.avg_response_ms ?? null,
    };
    channel = body.channel ?? "voice";
  } catch {
    return Response.json({ error: "Unable to verify this call summary." }, { status: 400 });
  }

  let summary: CallSummary | null = null;
  const provider = getProvider();
  if (provider && checkRateLimit(request, "summary")) {
    try {
      summary = await modelSummary(provider, input, AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]));
    } catch (error) {
      if (process.env.ARIA_PROVIDER_DEBUG === "1") console.error("Model summary failed; using rules", error);
    }
  }
  summary ??= rulesSummary(input);
  try {
    summary = callSummarySchema.parse(summary);
  } catch {
    summary = callSummarySchema.parse(rulesSummary(input));
  }

  // Best-effort analytics record. A read-only host simply keeps no record; the customer's
  // summary is never withheld because persistence failed.
  await saveConversation({
    sid: input.session.sid ?? "legacy-call",
    brand: input.session.brand ?? "aura",
    channel,
    summary,
  });

  return Response.json(summary);
}
