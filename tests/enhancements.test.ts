import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTurn } from "../src/lib/agent/agent";
import { executeTool, type ToolContext } from "../src/lib/agent/tools";
import { ticketCategory } from "../src/lib/ticketCategory";
import { newSession, ticketToken, verifyTicketToken } from "../src/lib/session";
import { computeAnalytics, type AnalyticsRange } from "../src/lib/analytics";
import {
  getTicket,
  readDatabase,
  saveConversation,
  saveFeedback,
  saveTicket,
  saveTurn,
  updateTicket,
  type Database,
} from "../src/lib/store";
import type { CallSummary, ChatMessage, SessionData } from "../src/types";
import { withEnv } from "./helpers";

const NO_KEYS = { GEMINI_API_KEY: undefined, OPENAI_API_KEY: undefined };

const ctx = (intent: ToolContext["intent"], session: SessionData = newSession(), ids: string[] = []): ToolContext => ({
  session,
  mentionedIds: new Set(ids),
  intent,
});

async function converse(session: SessionData, ...lines: string[]): Promise<string[]> {
  const messages: ChatMessage[] = [];
  const replies: string[] = [];
  for (const line of lines) {
    messages.push({ role: "user", content: line });
    const result = await runTurn(messages, session, () => {});
    messages.push({ role: "assistant", content: result.reply });
    replies.push(result.reply);
  }
  return replies;
}

async function tempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aria-store-"));
}

test("products: catalogue matches are brand-scoped and priced as listed", async () => {
  const aura = executeTool("find_products", { query: "moisturiser", concern: "dryness", skin_type: "dry" }, ctx("PRODUCT_QUESTION"));
  assert.equal(aura.status, "ok");
  const auraProducts = (aura.output as { products: { name: string; price_rupees: number }[] }).products;
  assert.ok(auraProducts.length > 0);
  assert.ok(auraProducts.some(item => item.name === "Ceramide Barrier Moisturiser"));
  assert.equal(auraProducts.find(item => item.name === "Ceramide Barrier Moisturiser")?.price_rupees, 1249);

  const budget = executeTool("find_products", { query: "sunscreen", max_price: 450 }, ctx("PRODUCT_QUESTION"));
  const within = (budget.output as { products?: { name: string; price_rupees: number }[] }).products ?? [];
  assert.ok(within.every(item => item.price_rupees <= 450), "nothing above the stated budget is recommended");
  assert.ok(!within.some(item => item.name.includes("Hydrating Sunscreen")), "the ₹499 sunscreen is excluded by the budget");

  const veda = executeTool("find_products", { query: "hair oil", concern: "hair fall" }, ctx("PRODUCT_QUESTION", newSession("veda")));
  assert.equal(veda.status, "ok");
  const vedaProducts = (veda.output as { products: { name: string }[] }).products;
  assert.ok(vedaProducts.every(item => !item.name.includes("Vitamin C")), "Veda never sees Aura's catalogue");
  assert.ok(vedaProducts.some(item => item.name.includes("Bhringraj")));
});

test("products: an unmatched goal says so instead of inventing a product", () => {
  const result = executeTool("find_products", { concern: "hair fall" }, ctx("PRODUCT_QUESTION", newSession("aura")));
  assert.equal(result.status, "needs_info");
  assert.equal(result.summary, "No catalogue match");
  const output = result.output as { found: boolean; products?: unknown[] };
  assert.equal(output.found, false);
  assert.equal(output.products, undefined);
});

test("memory: an arrival follow-up resolves the one order already discussed", () =>
  withEnv(NO_KEYS, async () => {
    const session = newSession();
    const replies = await converse(session, "Where is ORD-101?", "When will it arrive?");
    assert.match(replies[0], /ORD-101/);
    assert.match(replies[1], /ORD-101/, "the follow-up reuses the verified order");
    assert.match(replies[1], /BlueDart/);
  }));

test("memory: with two orders in play, a bare follow-up asks which one", () =>
  withEnv(NO_KEYS, async () => {
    const session = newSession();
    const replies = await converse(session, "Where is ORD-101?", "And where is ORD-102?", "When will it arrive?");
    assert.match(replies[1], /ORD-102/);
    assert.match(replies[2], /Which order do you mean/);
    assert.match(replies[2], /ORD-101/);
    assert.match(replies[2], /ORD-102/);
    assert.doesNotMatch(replies[2], /BlueDart|delivered 14 days ago/, "no order is guessed");
  }));

test("tickets: escalation reuses one reference and keeps the caller's category", async () => {
  const session = newSession();
  const conversation = await converse(session, "My order ORD-106 arrived damaged and I want to speak to a real person.");
  assert.match(conversation[0], /AUR-\d{4}/);
  assert.equal(session.escalations.length, 1);
  assert.equal(session.escalations[0].category, "Damaged Product", "the caller's words set the category");

  const first = executeTool("escalate_to_human", { reason: "The parcel arrived damaged and is late" }, ctx("HUMAN_HANDOFF", session));
  const second = executeTool("escalate_to_human", { reason: "Still needs help" }, ctx("HUMAN_HANDOFF", session));
  assert.equal(first.output.reference, second.output.reference);
  assert.equal(session.escalations.length, 1, "a retried turn cannot open a second ticket");
  assert.equal(session.escalations[0].status, "Open");
  assert.ok(session.escalations[0].created_at);

  assert.equal(ticketCategory("HUMAN_HANDOFF", "The courier is late"), "Delivery Issue");
  assert.equal(ticketCategory("HUMAN_HANDOFF", "I was charged twice on UPI"), "Payment Query");
  assert.equal(ticketCategory("RETURN_REQUEST", "anything"), "Return Request");
  assert.equal(ticketCategory("PRODUCT_QUESTION", "anything"), "Other");
});

test("store: tickets and feedback are deduplicated per call", async () => {
  const dir = await tempDataDir();
  await withEnv({ ARIA_DATA_DIR: dir }, async () => {
    const input = { reference: "AURA-1234", sid: "call-1", brand: "aura", category: "Delivery Issue" as const, reason: "Late parcel", order_id: "ORD-101" };
    const created = await saveTicket(input);
    const again = await saveTicket({ ...input, reason: "A different retry" });
    assert.equal(again.reference, created.reference);
    assert.equal(again.reason, "Late parcel", "the first record wins");

    const fetched = await getTicket("AURA-1234");
    assert.equal(fetched?.status, "Open");

    const rated = await saveFeedback({ sid: "call-1", brand: "aura", rating: 5, comment: "Helpful" });
    const retried = await saveFeedback({ sid: "call-1", brand: "aura", rating: 1, comment: "Changed my mind" });
    assert.equal(retried.id, rated.id);
    assert.equal(retried.rating, 5, "a retry never inflates or overrides CSAT");

    const db = await readDatabase();
    assert.equal(db.tickets.length, 1);
    assert.equal(db.feedback.length, 1);

    const updated = await updateTicket("AURA-1234", "Resolved");
    assert.equal(updated?.status, "Resolved");
    assert.equal(await updateTicket("NOPE-0000", "Closed"), null, "unknown references are not created");
  });
});

test("store: ticket tokens are signed and reject a guessed reference", () => {
  const token = ticketToken("AURA-1234");
  assert.equal(token, ticketToken("AURA-1234"));
  assert.equal(verifyTicketToken("AURA-1234", token), true);
  assert.equal(verifyTicketToken("AURA-9999", token), false, "a token for one reference cannot read another");
  assert.equal(verifyTicketToken("AURA-1234", `${token}x`), false);
  assert.equal(verifyTicketToken("AURA-1234", ""), false);
});

const summary = (overrides: Partial<CallSummary> = {}): CallSummary => ({
  brand: "aura",
  customer_intent: "ORDER_TRACKING",
  order_id: "ORD-101",
  resolution_status: "RESOLVED",
  call_summary: "Demo call.",
  customer_sentiment: "POSITIVE",
  follow_up_required: false,
  issues: [{ intent: "ORDER_TRACKING", order_id: "ORD-101", resolution: "RESOLVED" }],
  actions_taken: [],
  order_ids: ["ORD-101"],
  metrics: { customer_turns: 2, tool_calls: 1, duration_seconds: 40, avg_response_ms: 800 },
  generated_by: "rules",
  ...overrides,
});

const range = (): AnalyticsRange => ({ from: null, to: Date.now() + 60_000, label: "All time" });

test("analytics: an empty dataset reports zeroes, not failures", () => {
  const empty: Database = { version: 1, conversations: [], tickets: [], feedback: [], turns: [] };
  const result = computeAnalytics(empty, range());
  assert.equal(result.conversations.total, 0);
  assert.equal(result.tools.calls, 0);
  assert.equal(result.resolutionRate, null);
  assert.equal(result.feedback.average, null);
  assert.deepEqual(result.tickets.byStatus, []);
  assert.equal(result.demoOnly, true);
});

test("analytics: aggregates only verified records inside the range", async () => {
  const dir = await tempDataDir();
  await withEnv({ ARIA_DATA_DIR: dir }, async () => {
    const now = Date.now();
    await saveConversation({
      sid: "call-a",
      brand: "aura",
      channel: "voice",
      created_at: now,
      summary: summary({ actions_taken: ["Cancelled ORD-103 after the customer confirmed."] }),
    });
    await saveConversation({
      sid: "call-b",
      brand: "veda",
      channel: "text",
      created_at: now,
      summary: summary({
        brand: "veda",
        customer_intent: "RETURN_REQUEST",
        order_id: "ORD-202",
        resolution_status: "POLICY_DECLINED",
        issues: [{ intent: "RETURN_REQUEST", order_id: "ORD-202", resolution: "POLICY_DECLINED" }],
        follow_up_required: true,
        metrics: { customer_turns: 4, tool_calls: 2, duration_seconds: 90, avg_response_ms: 1200 },
      }),
    });
    await saveTicket({ reference: "AURA-1111", sid: "call-a", brand: "aura", category: "Delivery Issue", reason: "Late", order_id: "ORD-101", created_at: now });
    await saveFeedback({ sid: "call-a", brand: "aura", rating: 4, comment: "" });
    await saveFeedback({ sid: "call-b", brand: "veda", rating: 5, comment: "" });
    await saveTurn({ sid: "call-a", brand: "aura", mode: "demo", ms: 100, tool_calls: [{ name: "get_order_details", status: "ok", ms: 20 }], guardrails: 0, model_ms: [], error: null, at: now });
    await saveTurn({ sid: "call-b", brand: "veda", mode: "demo", ms: 100, tool_calls: [{ name: "check_return_eligibility", status: "declined", ms: 20 }], guardrails: 1, model_ms: [], error: "provider down", at: now });
    // Outside every in-range query below.
    await saveConversation({ sid: "call-old", brand: "aura", channel: "voice", created_at: now - 120 * 24 * 60 * 60 * 1000, summary: summary() });

    const db = await readDatabase();
    assert.equal(db.conversations.length, 3, "the old call is stored");

    const all = computeAnalytics(db, range());
    assert.equal(all.conversations.total, 3);
    assert.equal(all.conversations.voice, 2);
    assert.equal(all.conversations.text, 1);
    assert.equal(all.tools.calls, 2);
    assert.equal(all.tools.successful, 1);
    assert.equal(all.tools.unsuccessful, 1);
    assert.equal(all.activity.turnErrors, 1);
    assert.equal(all.activity.cancellations, 1);
    assert.equal(all.activity.returnRequests, 1);
    assert.equal(all.activity.escalations, 1);
    assert.equal(all.feedback.count, 2);
    assert.equal(all.feedback.average, 4.5);
    assert.equal(all.tickets.total, 1);
    assert.equal(all.tickets.open, 1);
    assert.equal(all.resolutionRate, 2 / 3);

    const recentFrom = now - 7 * 24 * 60 * 60 * 1000;
    const recent = computeAnalytics(db, { from: recentFrom, to: now + 60_000, label: "7 days" });
    assert.equal(recent.conversations.total, 2, "the old call drops out of the range");
    assert.equal(recent.feedback.average, 4.5);
    assert.equal(recent.resolutionRate, 1 / 2);
  });
});
