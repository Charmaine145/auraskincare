import { z } from "zod";
import { checkRateLimit } from "@/lib/rateLimit";
import { readSession } from "@/lib/session";
import { saveFeedback } from "@/lib/store";
import { readBody, sessionTokenSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  session: sessionTokenSchema,
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional().default(""),
}).strict();

/** Satisfaction feedback for a finished call. Idempotent per call, so a retry can't inflate CSAT. */
export async function POST(request: Request) {
  if (!checkRateLimit(request, "feedback")) return Response.json({ error: "Too many requests. Please try again later." }, { status: 429 });
  let input: z.infer<typeof bodySchema>;
  let session;
  try {
    input = bodySchema.parse(await readBody(request));
    session = readSession(input.session);
  } catch {
    return Response.json({ error: "This call has ended or expired, so feedback can't be saved." }, { status: 400 });
  }
  if (input.session && !session.sid) return Response.json({ error: "This call can't be matched to a record." }, { status: 400 });
  try {
    const saved = await saveFeedback({
      sid: session.sid ?? `legacy-${input.session?.slice(-24) ?? "unknown"}`,
      brand: session.brand ?? "aura",
      rating: input.rating,
      comment: input.comment,
    });
    return Response.json({ saved: true, rating: saved.rating });
  } catch {
    return Response.json({ error: "Feedback couldn't be saved on this server. Nothing was recorded." }, { status: 503 });
  }
}
