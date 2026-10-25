import { brandById, type Brand } from "@/data/brand";
import { formatClock, formatMs, humanize } from "@/lib/format";
import { normalizeOrderId } from "@/lib/orders/orderIds";
import type { CallRecap, CallSummary, ChatMessage, Intent, RecapAction, Resolution, SessionData, ToolName, ToolStatus } from "@/types";

/**
 * Builds the customer-facing recap from the signed session and transcript.
 *
 * Transaction claims (attempted actions and verified outcomes) come only from the server's
 * recorded tool results, the `cancelled` list and escalations. The model's narrative can never
 * promote an attempt to a success. Text is also limited to orders this call's brand may see and
 * is stripped of unnecessary contact details.
 */

const MAX_KEY_POINTS = 5;
const MAX_ACTIONS = 8;
const MAX_OUTCOMES = 8;
const MAX_UNRESOLVED = 6;
const MAX_NEXT_STEPS = 5;

const ISSUE_LABEL: Record<Intent, string> = {
  ORDER_TRACKING: "Order status",
  CANCELLATION: "Order cancellation",
  RETURN_REQUEST: "Return eligibility",
  DAMAGED_PRODUCT: "Damaged product",
  POLICY_QUESTION: "Policy question",
  PRODUCT_QUESTION: "Product advice",
  HUMAN_HANDOFF: "Care-team handoff",
  OUT_OF_SCOPE: "Out-of-scope request",
  GENERAL: "General enquiry",
};

export const RESULT_LABEL: Record<RecapAction["result"], string> = {
  confirmed: "Confirmed",
  failed: "Failed",
  unconfirmed: "Unconfirmed",
};

export const allowedOrders = (brand: Brand): Set<string> => new Set(brand.orders.map(order => order.order_id));

/** A short, deterministic label for a tool-backed action. */
export function actionLabel(name: ToolName, status: ToolStatus): string {
  switch (name) {
    case "get_order_details":
      return "Order lookup";
    case "cancel_order":
      return status === "done" ? "Cancellation" : "Cancellation check";
    case "check_return_eligibility":
      return "Return check";
    case "escalate_to_human":
      return "Care-team handoff";
    case "find_products":
      return "Product search";
  }
}

export function resultFor(status: ToolStatus): RecapAction["result"] {
  switch (status) {
    case "ok":
    case "done":
      return "confirmed";
    case "confirm":
    case "needs_info":
      return "unconfirmed";
    case "not_found":
    case "declined":
    case "blocked":
    case "error":
      return "failed";
    default:
      return "unconfirmed";
  }
}

const isAuthorized = (id: string | null | undefined, allowed: Set<string>): id is string =>
  Boolean(id && allowed.has(normalizeOrderId(id)));

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/**
 * Removes order references this call is not allowed to discuss plus unnecessary contact details.
 * Server summaries are already short facts; this is a final guard for transcript-derived text.
 */
export function safeRecapText(value: string, allowed: Set<string>): string {
  return oneLine(value)
    .replace(/\b(?:sk|pk|rk|AIza|ghp|gho|xox[baprs])[-_A-Za-z0-9]{10,}\b/g, "[secret]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:\+?\d[\d ().-]{6,}\d)\b/g, "[number]")
    .replace(/\bORD-\d{3,}\b/gi, token => {
      const id = token.toUpperCase();
      return allowed.has(id) ? id : "an unverified order";
    });
}

const unique = (items: string[]): string[] => {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const RESOLUTION_NOTE: Record<Extract<Resolution, "NEEDS_INFORMATION" | "UNRESOLVED" | "ESCALATED">, string> = {
  NEEDS_INFORMATION: "still needs information",
  UNRESOLVED: "not resolved",
  ESCALATED: "handed to the care team",
};

export interface RecapInput {
  brand: Brand;
  session: SessionData;
  transcript: ChatMessage[];
  intent: Intent;
  resolution: CallSummary["resolution_status"];
  issues: CallSummary["issues"];
  /** The summary's primary order; recap shows it only when this brand may access it. */
  orderId: string | null;
  followUpRequired: boolean;
}

export function buildRecap({ brand, session, transcript, intent, resolution, issues, orderId, followUpRequired }: RecapInput): CallRecap {
  const allowed = allowedOrders(brand);
  const empty = resolution === "NO_CONVERSATION";
  const findings = session.toolResults ?? [];
  const orderReference = isAuthorized(orderId, allowed) ? normalizeOrderId(orderId) : null;

  const issue = empty
    ? "No customer request was recorded before the call ended."
    : `${ISSUE_LABEL[intent]}${orderReference ? ` for ${orderReference}` : ""}.`;

  const greeting = /^(hi|hello|hey|good (morning|afternoon|evening)|namaste|thanks|thank you|ok|okay)[.! ]*$/i;
  const keyPoints = unique(
    transcript
      .filter(message => message.role === "user")
      .map(message => oneLine(safeRecapText(message.content, allowed)))
      .filter(line => line.length >= 6 && !greeting.test(line))
      .map(line => clip(line, 180)),
  ).slice(0, MAX_KEY_POINTS);

  const attempted = findings
    .slice(-MAX_ACTIONS)
    .map(action => {
      const order = isAuthorized(action.order_id, allowed) ? normalizeOrderId(action.order_id) : null;
      return {
        action: actionLabel(action.name, action.status),
        order_id: order,
        result: resultFor(action.status),
        detail: clip(safeRecapText(action.summary, allowed), 220),
      };
    });

  const outcomeDetails = session.outcomes
    .filter(outcome => outcome.intent !== "GENERAL")
    .map(outcome => oneLine(safeRecapText(outcome.detail, allowed)));
  const cancelled = session.cancelled
    .filter(id => isAuthorized(id, allowed))
    .map(id => `Cancelled ${normalizeOrderId(id)} after the customer confirmed.`);
  const escalations = session.escalations.map(escalation => {
    const order = isAuthorized(escalation.order_id, allowed) ? escalation.order_id : null;
    return `Created care-team request ${escalation.reference}${order ? ` for ${order}` : ""}.`;
  });
  const verifiedOutcomes = unique([...outcomeDetails, ...cancelled, ...escalations]).slice(0, MAX_OUTCOMES);

  const unresolved: string[] = [];
  for (const item of issues) {
    if (item.resolution === "NEEDS_INFORMATION" || item.resolution === "UNRESOLVED" || item.resolution === "ESCALATED") {
      const order = isAuthorized(item.order_id, allowed) ? item.order_id : null;
      unresolved.push(`${humanize(item.intent)}${order ? ` · ${order}` : ""}: ${RESOLUTION_NOTE[item.resolution]}`);
    }
  }
  // Only the newest attempt for a tool and order counts. An earlier "shall I cancel?" must not
  // remain unresolved after the cancellation was confirmed or after a later return check passed.
  const latest = new Map<string, ToolStatus>();
  for (const finding of findings) {
    const order = isAuthorized(finding.order_id, allowed) ? normalizeOrderId(finding.order_id) : "";
    latest.set(`${finding.name}:${order}`, finding.status);
  }
  for (const action of findings) {
    if (action.status !== "needs_info" && action.status !== "confirm") continue;
    const order = isAuthorized(action.order_id, allowed) ? normalizeOrderId(action.order_id) : null;
    if (latest.get(`${action.name}:${order ?? ""}`) !== action.status) continue;
    if (action.status === "confirm" && order && session.cancelled.includes(order)) continue;
    const detail = clip(safeRecapText(action.summary, allowed), 220);
    unresolved.push(`${actionLabel(action.name, action.status)}${order ? ` · ${order}` : ""}: ${detail}`);
  }
  if (isAuthorized(session.pendingCancel, allowed)) {
    unresolved.push(`Cancellation · ${session.pendingCancel}: waiting for the customer's confirmation; no change has been made.`);
  }

  const nextSteps: string[] = [];
  if (empty) nextSteps.push("No follow-up is needed; the call ended before a request was made.");
  if (isAuthorized(session.pendingCancel, allowed)) {
    nextSteps.push(`Confirm or decline the cancellation of ${session.pendingCancel}. Nothing has been changed yet.`);
  }
  for (const item of issues) {
    const order = isAuthorized(item.order_id, allowed) ? item.order_id : null;
    if (item.resolution === "NEEDS_INFORMATION") {
      if (item.intent === "CANCELLATION" && order) nextSteps.push(`Ask the customer to confirm before cancelling ${order}.`);
      else if (order) nextSteps.push(`Provide the information Aria asked for about ${order}.`);
      else nextSteps.push("Provide the missing details so the request can be checked.");
    } else if (item.resolution === "UNRESOLVED") {
      nextSteps.push(`Review the unresolved ${humanize(item.intent).toLowerCase()} request${order ? ` for ${order}` : ""}.`);
    } else if (item.resolution === "ESCALATED") {
      const references = session.escalations.map(escalation => escalation.reference);
      if (references.length) nextSteps.push(`Care team to review ticket ${references.join(", ")}.`);
    }
  }
  if (session.escalations.length && !nextSteps.some(step => step.startsWith("Care team to review"))) {
    nextSteps.push(`Care team to review ticket ${session.escalations.map(escalation => escalation.reference).join(", ")}.`);
  }
  if (followUpRequired && nextSteps.length === 0) nextSteps.push("The care team should follow up on the open request.");
  if (nextSteps.length === 0) nextSteps.push("No further action is needed.");

  return {
    issue,
    order_reference: orderReference,
    key_points: keyPoints,
    attempted_actions: attempted,
    verified_outcomes: verifiedOutcomes,
    unresolved_issues: unique(unresolved).slice(0, MAX_UNRESOLVED),
    next_steps: unique(nextSteps).slice(0, MAX_NEXT_STEPS),
  };
}

const fallbackRecap = (summary: CallSummary): CallRecap => {
  const allowed = allowedOrders(brandById(summary.brand));
  const order = summary.order_ids.find(id => isAuthorized(id, allowed)) ?? null;
  return {
    issue: clip(safeRecapText(summary.call_summary, allowed), 300),
    order_reference: order,
    key_points: [],
    attempted_actions: [],
    verified_outcomes: summary.actions_taken.map(action => safeRecapText(action, allowed)),
    unresolved_issues: summary.resolution_status === "RESOLVED" || summary.resolution_status === "NO_CONVERSATION" ? [] : [humanize(summary.resolution_status)],
    next_steps: [],
  };
};

const section = (title: string, items: string[]): string[] => (items.length ? ["", `## ${title}`, ...items.map(item => `- ${item}`)] : []);

/** A readable Markdown file. It contains the recap only: no transcript, prompts or raw records. */
export function recapMarkdown(summary: CallSummary): string {
  const business = brandById(summary.brand);
  const allowed = allowedOrders(business);
  const recap = summary.recap ?? fallbackRecap(summary);
  const metrics = summary.metrics;
  const meta = [
    metrics.duration_seconds !== null ? `Duration: ${formatClock(metrics.duration_seconds)}` : "Duration: not recorded",
    `Customer turns: ${metrics.customer_turns}`,
    `Tool calls: ${metrics.tool_calls}`,
    metrics.avg_response_ms !== null ? `Average reply: ${formatMs(metrics.avg_response_ms)}` : null,
  ].filter((line): line is string => Boolean(line));

  const lines = [
    `# ${business.name} — conversation recap`,
    "",
    `**Issue:** ${recap.issue}`,
    `**Order reference:** ${recap.order_reference ?? "None"}`,
    `**Resolution:** ${humanize(summary.resolution_status)}`,
    `**Sentiment:** ${humanize(summary.customer_sentiment)}`,
    ...section("Key discussion points", recap.key_points),
    ...section(
      "Attempted actions",
      recap.attempted_actions.map(action =>
        `**${action.action}${action.order_id ? ` · ${action.order_id}` : ""}** — ${RESULT_LABEL[action.result]}: ${action.detail}`,
      ),
    ),
    ...section("Verified outcomes", recap.verified_outcomes),
    ...section("Unresolved issues", recap.unresolved_issues),
    ...section("Next steps", recap.next_steps),
    "",
    "## Call details",
    ...meta.map(line => `- ${line}`),
    "- Source: the signed call record's verified tool results",
    "",
    "_Transaction statuses above come from the server record; the written summary cannot change them._",
    "",
  ];
  return lines.join("\n");
}
