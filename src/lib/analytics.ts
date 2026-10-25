import type { Intent, Resolution } from "@/types";
import type { Database, StoredConversation } from "./store";

/** Pure aggregation for the protected admin view. No personal data, no transcripts. */

export interface AnalyticsRange {
  /** Inclusive start, or null for "all time". */
  from: number | null;
  to: number;
  label: string;
}

export interface Analytics {
  range: AnalyticsRange;
  demoOnly: boolean;
  conversations: {
    total: number;
    voice: number;
    text: number;
    withSummary: number;
    byBrand: { brand: string; count: number }[];
  };
  intents: { intent: Intent; count: number }[];
  tools: {
    calls: number;
    successful: number;
    unsuccessful: number;
    pending: number;
    byTool: { name: string; calls: number; successful: number; declined: number }[];
  };
  resolutions: { status: Resolution | "NO_CONVERSATION"; count: number }[];
  resolutionRate: number | null;
  tickets: {
    total: number;
    open: number;
    byStatus: { status: string; count: number }[];
    byCategory: { category: string; count: number }[];
  };
  feedback: {
    count: number;
    average: number | null;
    distribution: { rating: number; count: number }[];
  };
  activity: {
    cancellations: number;
    returnRequests: number;
    escalations: number;
    avgResponseMs: number | null;
    turns: number;
    turnErrors: number;
  };
}

const SUCCESS = new Set(["ok", "done"]);
const UNSUCCESSFUL = new Set(["declined", "blocked", "error", "not_found"]);

const inRange = (at: number, range: AnalyticsRange) => at >= (range.from ?? 0) && at <= range.to;

function group<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
  return map;
}

function rate(part: number, total: number): number | null {
  return total === 0 ? null : part / total;
}

export function computeAnalytics(db: Database, range: AnalyticsRange): Analytics {
  const conversations = db.conversations.filter(item => inRange(item.created_at, range));
  const tickets = db.tickets.filter(item => inRange(item.created_at, range));
  const feedback = db.feedback.filter(item => inRange(item.created_at, range));
  const turns = db.turns.filter(item => inRange(item.at, range));

  const intentCounts = new Map<Intent, number>();
  for (const conversation of conversations) {
    const seen = new Set<Intent>();
    for (const issue of conversation.summary.issues) seen.add(issue.intent);
    seen.add(conversation.summary.customer_intent);
    for (const intent of seen) intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + 1);
  }

  const toolCalls = turns.flatMap(turn => turn.tool_calls);
  const byTool = new Map<string, { calls: number; successful: number; declined: number }>();
  for (const call of toolCalls) {
    const row = byTool.get(call.name) ?? { calls: 0, successful: 0, declined: 0 };
    row.calls++;
    if (SUCCESS.has(call.status)) row.successful++;
    if (UNSUCCESSFUL.has(call.status)) row.declined++;
    byTool.set(call.name, row);
  }

  const successful = toolCalls.filter(call => SUCCESS.has(call.status)).length;
  const unsuccessful = toolCalls.filter(call => UNSUCCESSFUL.has(call.status)).length;

  const resolutions = group(conversations, item => item.summary.resolution_status);
  const resolved = resolutions.get("RESOLVED") ?? 0;
  const summarised = conversations.filter(item => item.summary.resolution_status !== "NO_CONVERSATION").length;

  const ratings = feedback.map(item => item.rating).filter(rating => rating >= 1 && rating <= 5);
  const latency = conversations.map(item => item.summary.metrics.avg_response_ms).filter((value): value is number => typeof value === "number");

  return {
    range,
    demoOnly: true,
    conversations: {
      total: conversations.length,
      voice: conversations.filter(item => item.channel === "voice").length,
      text: conversations.filter(item => item.channel === "text").length,
      withSummary: summarised,
      byBrand: [...group(conversations, item => item.brand)].map(([brand, count]) => ({ brand, count })).sort((a, b) => b.count - a.count),
    },
    intents: [...intentCounts].map(([intent, count]) => ({ intent, count })).sort((a, b) => b.count - a.count),
    tools: {
      calls: toolCalls.length,
      successful,
      unsuccessful,
      pending: toolCalls.length - successful - unsuccessful,
      byTool: [...byTool].map(([name, row]) => ({ name, ...row })).sort((a, b) => b.calls - a.calls),
    },
    resolutions: [...resolutions].map(([status, count]) => ({ status: status as Resolution | "NO_CONVERSATION", count })),
    resolutionRate: rate(resolved, summarised),
    tickets: {
      total: tickets.length,
      open: tickets.filter(item => item.status === "Open" || item.status === "In Progress").length,
      byStatus: [...group(tickets, item => item.status)].map(([status, count]) => ({ status, count })),
      byCategory: [...group(tickets, item => item.category)].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    },
    feedback: {
      count: ratings.length,
      average: ratings.length ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length : null,
      distribution: [1, 2, 3, 4, 5].map(rating => ({ rating, count: ratings.filter(value => value === rating).length })),
    },
    activity: {
      cancellations: conversations.filter(item => item.summary.actions_taken.some(action => /^Cancelled /i.test(action))).length,
      returnRequests: uniqueConversations(conversations, "RETURN_REQUEST"),
      escalations: conversations.filter(item => item.summary.follow_up_required).length,
      avgResponseMs: latency.length ? Math.round(latency.reduce((sum, value) => sum + value, 0) / latency.length) : null,
      turns: turns.length,
      turnErrors: turns.filter(turn => turn.error).length,
    },
  };
}

function uniqueConversations(conversations: StoredConversation[], intent: Intent): number {
  return conversations.filter(item => item.summary.issues.some(issue => issue.intent === intent)).length;
}
