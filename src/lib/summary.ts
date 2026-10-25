import { z } from "zod";
import { brandById, type Brand } from "@/data/brand";
import type { ChatProvider } from "@/lib/agent/providers";
import { buildRecap } from "@/lib/recap";
import type { CallSummary, ChatMessage, Intent, Resolution, SessionData, TurnOutcome } from "@/types";

/**
 * Post-call record. Facts (order IDs, actions, per-issue outcomes, metrics) always come
 * from the signed session. The model only writes the narrative and classification,
 * and its output is schema-validated; if anything fails, a rule-based summary is used.
 */

export const INTENTS = ["ORDER_TRACKING", "CANCELLATION", "RETURN_REQUEST", "DAMAGED_PRODUCT", "POLICY_QUESTION", "PRODUCT_QUESTION", "HUMAN_HANDOFF", "OUT_OF_SCOPE", "GENERAL"] as const satisfies readonly Intent[];
export const RESOLUTIONS = ["RESOLVED", "POLICY_DECLINED", "NEEDS_INFORMATION", "ESCALATED", "UNRESOLVED"] as const satisfies readonly Resolution[];
const SENTIMENTS = ["POSITIVE", "NEUTRAL", "NEGATIVE"] as const;

export interface SummaryInput {
  session: SessionData;
  transcript: ChatMessage[];
  durationSeconds: number | null;
  avgResponseMs: number | null;
}

type Issue = CallSummary["issues"][number];
/** A real order of this call's brand (as opposed to an ID that wasn't found). */
const knownOrder = (brand: Brand, id: string | null) => Boolean(id && brand.orders.some(o => o.order_id === id));

/** One entry per (intent, order); a later outcome updates the earlier one. */
export function mergeIssues(outcomes: TurnOutcome[], brand: Brand = brandById()): Issue[] {
  const issues: Issue[] = [];
  for (const outcome of outcomes) {
    if (outcome.intent === "GENERAL") continue;
    // "What's your order ID?" followed by the real order is one issue, not two.
    if (knownOrder(brand, outcome.order_id)) {
      for (let i = issues.length - 1; i >= 0; i--) {
        const earlier = issues[i];
        if (earlier.intent === outcome.intent && earlier.resolution === "NEEDS_INFORMATION" && !knownOrder(brand, earlier.order_id)) issues.splice(i, 1);
      }
    }
    const existing = issues.find(i => i.intent === outcome.intent && i.order_id === outcome.order_id);
    if (existing) existing.resolution = outcome.resolution;
    else issues.push({ intent: outcome.intent, order_id: outcome.order_id, resolution: outcome.resolution });
  }
  return issues;
}

const intentPhrase = (intent: Intent, brand: Brand): string => ({
  ORDER_TRACKING: "the status of an order",
  CANCELLATION: "cancelling an order",
  RETURN_REQUEST: "returning a product",
  DAMAGED_PRODUCT: "a damaged product",
  POLICY_QUESTION: `${brand.shortName}'s policies`,
  PRODUCT_QUESTION: "products and routines",
  HUMAN_HANDOFF: "speaking with a person",
  OUT_OF_SCOPE: `a request outside ${brand.shortName} support`,
  GENERAL: "a general enquiry",
})[intent];

function sentimentOf(transcript: ChatMessage[]): CallSummary["customer_sentiment"] {
  const said = transcript.filter(m => m.role === "user").map(m => m.content.toLowerCase()).join(" ");
  if (/\b(angry|frustrat\w*|worst|terrible|useless|disappointed|ridiculous|pathetic|unacceptable|upset)\b/.test(said)) return "NEGATIVE";
  if (/\b(thanks|thank you|great|perfect|awesome|wonderful|helpful|dhanyavaa?d|shukriya)\b/.test(said)) return "POSITIVE";
  return "NEUTRAL";
}

export function rulesSummary({ session, transcript, durationSeconds, avgResponseMs }: SummaryInput): CallSummary {
  const brand = brandById(session.brand);
  const issues = mergeIssues(session.outcomes, brand);
  const customerTurns = transcript.filter(m => m.role === "user").length;
  const primary = issues[0];
  const intent: Intent = primary?.intent ?? "GENERAL";
  const latestForIntent = [...issues].reverse().find(i => i.intent === intent);
  const details = [...new Set(session.outcomes.filter(o => o.intent !== "GENERAL").map(o => o.detail))];
  const call_summary = customerTurns === 0
    ? "The call ended before the customer asked anything."
    : details.length
      ? `Customer called about ${intentPhrase(intent, brand)}. ${details.join(" ")}`
      : "Customer greeted Aria but did not raise a specific request.";
  const resolution_status: CallSummary["resolution_status"] =
    customerTurns === 0 ? "NO_CONVERSATION" : session.escalations.length && intent === "HUMAN_HANDOFF" ? "ESCALATED" : latestForIntent?.resolution ?? "UNRESOLVED";
  const order_ids = [...new Set(issues.map(i => i.order_id).filter((id): id is string => knownOrder(brand, id)))];
  const follow_up_required = session.escalations.length > 0;
  const order_id = primaryOrder(issues, intent, brand);

  return {
    brand: brand.name,
    customer_intent: intent,
    order_id,
    resolution_status,
    call_summary,
    customer_sentiment: sentimentOf(transcript),
    follow_up_required,
    issues,
    actions_taken: [
      ...session.cancelled.map(id => `Cancelled ${id} after the customer confirmed`),
      ...session.escalations.map(e => `Created care team request ${e.reference}`),
    ],
    order_ids,
    metrics: { customer_turns: customerTurns, tool_calls: session.toolCalls, duration_seconds: durationSeconds, avg_response_ms: avgResponseMs },
    generated_by: "rules",
    recap: buildRecap({ brand, session, transcript, intent, resolution: resolution_status, issues, orderId: order_id, followUpRequired: follow_up_required }),
  };
}

/** The order most relevant to the call's main intent: a real order first, else any ID given. */
function primaryOrder(issues: Issue[], intent: Intent, brand: Brand): string | null {
  const forIntent = issues.filter(i => i.intent === intent && i.order_id);
  return forIntent.find(i => knownOrder(brand, i.order_id))?.order_id ?? forIntent[0]?.order_id ?? null;
}

const summarySystem = (brand: Brand) => `You write structured post-call records for ${brand.name}'s customer care team.
Use only the transcript and the verified tool outcomes. Verified outcomes are ground truth for what was looked up, declined, cancelled or escalated; never contradict them or invent order details.
customer_intent: the main reason the customer called; if several, the first substantive one.
resolution_status for the call overall: RESOLVED (request fulfilled or question fully answered), POLICY_DECLINED (the main request was refused under policy or was out of scope), NEEDS_INFORMATION (the call ended while Aria still needed something, such as an order ID or a confirmation), ESCALATED (handed to the human care team), UNRESOLVED (anything else).
call_summary: one to three sentences, third person, past tense, starting with "Customer". Be specific: order IDs, statuses, decisions and actions.
customer_sentiment: POSITIVE, NEUTRAL or NEGATIVE.
follow_up_required: true only if someone at ${brand.shortName} must act after the call.`;

const llmSchema = z.object({
  customer_intent: z.enum(INTENTS),
  resolution_status: z.enum(RESOLUTIONS),
  call_summary: z.string().trim().min(10).max(700),
  customer_sentiment: z.enum(SENTIMENTS),
  follow_up_required: z.boolean(),
});

const RESOLUTIONS_OR_EMPTY = [...RESOLUTIONS, "NO_CONVERSATION"] as const;

const recapActionSchema = z.object({
  action: z.string().trim().min(1).max(80),
  order_id: z.string().trim().min(1).max(40).nullable(),
  result: z.enum(["confirmed", "failed", "unconfirmed"]),
  detail: z.string().trim().max(300),
}).strict();

export const callRecapSchema = z.object({
  issue: z.string().trim().min(1).max(400),
  order_reference: z.string().trim().min(1).max(40).nullable(),
  key_points: z.array(z.string().trim().max(220)).max(6),
  attempted_actions: z.array(recapActionSchema).max(10),
  verified_outcomes: z.array(z.string().trim().max(400)).max(10),
  unresolved_issues: z.array(z.string().trim().max(300)).max(8),
  next_steps: z.array(z.string().trim().max(300)).max(6),
}).strict();

/** Final boundary validation: a malformed summary is never returned or downloaded. */
export const callSummarySchema = z.object({
  brand: z.string().trim().min(1).max(80),
  customer_intent: z.enum(INTENTS),
  order_id: z.string().trim().min(1).max(40).nullable(),
  resolution_status: z.enum(RESOLUTIONS_OR_EMPTY),
  call_summary: z.string().trim().min(1).max(20_000),
  customer_sentiment: z.enum(SENTIMENTS),
  follow_up_required: z.boolean(),
  issues: z.array(z.object({
    intent: z.enum(INTENTS),
    order_id: z.string().trim().min(1).max(40).nullable(),
    resolution: z.enum(RESOLUTIONS),
  }).strict()).max(60),
  actions_taken: z.array(z.string().trim().max(400)).max(80),
  order_ids: z.array(z.string().trim().min(1).max(40)).max(80),
  metrics: z.object({
    customer_turns: z.number().int().min(0).max(500),
    tool_calls: z.number().int().min(0).max(500),
    duration_seconds: z.number().int().min(0).max(86_400).nullable(),
    avg_response_ms: z.number().int().min(0).max(120_000).nullable(),
  }).strict(),
  generated_by: z.string().trim().min(1).max(80),
  recap: callRecapSchema.optional(),
}).strict();

const jsonSchema = {
  type: "object",
  properties: {
    customer_intent: { type: "string", enum: INTENTS },
    resolution_status: { type: "string", enum: RESOLUTIONS },
    call_summary: { type: "string" },
    customer_sentiment: { type: "string", enum: SENTIMENTS },
    follow_up_required: { type: "boolean" },
  },
  required: ["customer_intent", "resolution_status", "call_summary", "customer_sentiment", "follow_up_required"],
  additionalProperties: false,
};

export async function modelSummary(provider: ChatProvider, input: SummaryInput, signal?: AbortSignal): Promise<CallSummary> {
  const base = rulesSummary(input);
  if (base.metrics.customer_turns === 0) return base;

  const transcript = input.transcript.slice(-60).map(m => `${m.role === "user" ? "Customer" : "Aria"}: ${m.content.slice(0, 500)}`).join("\n");
  const outcomes = input.session.outcomes.map(o => `- [${o.intent} · ${o.order_id ?? "no order"} · ${o.resolution}] ${o.detail}`).join("\n") || "- none";
  const escalations = input.session.escalations.map(e => `- ${e.reference}: ${e.reason}`).join("\n") || "- none";
  const raw = await provider.json<unknown>({
    system: summarySystem(brandById(input.session.brand)),
    prompt: `Transcript:\n${transcript}\n\nVerified tool outcomes (chronological):\n${outcomes}\n\nCare team requests:\n${escalations}`,
    schema: jsonSchema,
    signal,
  });
  const parsed = llmSchema.parse(raw);

  // Reject a narrative that mentions an order nobody discussed.
  const discussed = new Set([...base.issues.map(i => i.order_id), ...input.transcript.flatMap(m => m.content.toUpperCase().match(/\bORD-\d+\b/g) ?? [])]);
  const mentioned = parsed.call_summary.toUpperCase().match(/\bORD-\d+\b/g) ?? [];
  if (mentioned.some(id => !discussed.has(id))) throw new Error("Summary referenced an order that was not discussed.");

  const orderId = primaryOrder(base.issues, parsed.customer_intent, brandById(input.session.brand)) ?? (parsed.customer_intent === base.customer_intent ? base.order_id : null);
  const followUpRequired = parsed.follow_up_required || input.session.escalations.length > 0;

  return {
    ...base,
    customer_intent: parsed.customer_intent,
    order_id: orderId,
    resolution_status: parsed.resolution_status,
    call_summary: parsed.call_summary,
    customer_sentiment: parsed.customer_sentiment,
    follow_up_required: followUpRequired,
    generated_by: provider.model,
    // Rebuild from verified data with the model's classification; never from its prose.
    recap: buildRecap({
      brand: brandById(input.session.brand),
      session: input.session,
      transcript: input.transcript,
      intent: parsed.customer_intent,
      resolution: parsed.resolution_status,
      issues: base.issues,
      orderId,
      followUpRequired,
    }),
  };
}
