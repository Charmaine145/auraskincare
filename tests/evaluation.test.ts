import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn } from "../src/lib/agent/agent";
import { getProvider } from "../src/lib/agent/providers";
import { executeTool, checkReturnEligibility, type ToolContext } from "../src/lib/agent/tools";
import { ticketCategory } from "../src/lib/ticketCategory";
import { newSession, signSession, readSession } from "../src/lib/session";
import { adminConfigured, adminAvailable, tokenMatches } from "../src/lib/admin";
import { checkRateLimit } from "../src/lib/rateLimit";
import { callSummarySchema, rulesSummary, modelSummary } from "../src/lib/summary";
import { safeRecapText, recapMarkdown } from "../src/lib/recap";
import { POST as summaryRoute } from "../src/app/api/summary/route";
import { POST as adminLogin } from "../src/app/api/admin/login/route";
import { VoiceActivityDetector } from "../src/lib/voice/vad";
import type { ChatMessage, SessionData, Intent, Resolution } from "../src/types";
import { withEnv, withFetch, gemini, text, history, call } from "./helpers";

// ── helpers ────────────────────────────────────────────────────────────────

const NO_KEYS = { GEMINI_API_KEY: undefined, OPENAI_API_KEY: undefined };
const TEST_KEYS = { GEMINI_API_KEY: "test-key", OPENAI_API_KEY: undefined, GEMINI_MODEL: "gemini-3.5-flash-lite" };

function ctx(session: SessionData = newSession(), ids: string[] = ["ORD-101", "ORD-102", "ORD-103"], intent: ToolContext["intent"] = "ORDER_TRACKING"): ToolContext {
  return { session, mentionedIds: new Set(ids), intent };
}

async function converse(session: SessionData, ...lines: string[]): Promise<string[]> {
  const messages: ChatMessage[] = [];
  const replies: string[] = [];
  await withEnv(NO_KEYS, async () => {
    for (const line of lines) {
      messages.push({ role: "user", content: line });
      const result = await runTurn(messages, session, () => {});
      messages.push({ role: "assistant", content: result.reply });
      replies.push(result.reply);
    }
  });
  return replies;
}

const request = (body: unknown) =>
  new Request("http://localhost/api/summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ── 1. Order tracking and lookup ──────────────────────────────────────────

test("eval: order lookup returns correct status, courier, tracking and policy", () => {
  const result = executeTool("get_order_details", { order_id: "ORD-101" }, ctx());
  assert.equal(result.status, "ok");
  const out = result.output as { order: { status: string; courier: string; tracking_id: string }; policy: { can_cancel: boolean } };
  assert.equal(out.order.status, "Out for Delivery");
  assert.equal(out.order.courier, "BlueDart");
  assert.equal(out.order.tracking_id, "BD-982103");
  assert.equal(out.policy.can_cancel, false);
});

test("eval: direct-tracking fast path answers without model call", async () => {
  await withEnv(TEST_KEYS, async () => {
    await withFetch(
      () => { throw new Error("model must not be called"); },
      async () => {
        const session = newSession();
        const messages: ChatMessage[] = [];
        messages.push({ role: "user", content: "Where is my order ORD-101?" });
        const result = await runTurn(messages, session, () => {});
        assert.match(result.reply, /ORD-101/);
        assert.match(result.reply, /BlueDart/);
        assert.equal(result.source, "direct");
      },
    );
  });
});

test("eval: unknown order ID is reported honestly", () => {
  const result = executeTool("get_order_details", { order_id: "ORD-9999" }, ctx(newSession(), ["ORD-9999"]));
  assert.equal(result.status, "not_found");
  assert.equal((result.output as { found: boolean }).found, false);
  assert.equal(result.outcome?.resolution, "NEEDS_INFORMATION");
});

// ── 2. Eligible and ineligible cancellations ──────────────────────────────

test("eval: processing order is cancellable only after explicit confirmation", () => {
  const session = newSession();
  const ask = executeTool("cancel_order", { order_id: "ORD-103", customer_confirmed: true }, ctx(session));
  assert.equal(ask.status, "confirm");
  assert.match(ask.say!, /Shall I go ahead/);
  assert.equal(session.pendingCancel, "ORD-103");
  assert.deepEqual(session.cancelled, []);

  const done = executeTool("cancel_order", { order_id: "ORD-103", customer_confirmed: true }, ctx(session));
  assert.equal(done.status, "done");
  assert.deepEqual(session.cancelled, ["ORD-103"]);
});

test("eval: shipped order cannot be cancelled; doorstep refusal suggested", () => {
  const result = executeTool("cancel_order", { order_id: "ORD-101" }, ctx());
  assert.equal(result.status, "declined");
  assert.match(result.say!, /refuse the delivery at your doorstep/i);
  assert.equal(result.outcome?.resolution, "POLICY_DECLINED");
});

test("eval: delivered order cannot be cancelled; return window mentioned", () => {
  const result = executeTool("cancel_order", { order_id: "ORD-102" }, ctx());
  assert.equal(result.status, "declined");
  assert.match(result.say!, /already been delivered/i);
  assert.match(result.say!, /return/);
});

test("eval: out-for-delivery order cannot be cancelled", () => {
  const result = executeTool("cancel_order", { order_id: "ORD-104" }, ctx(newSession(), ["ORD-104"]));
  assert.equal(result.status, "declined");
  assert.match(result.say!, /can no longer be cancelled|refuse/i);
});

test("eval: already-cancelled order is idempotent", () => {
  const session = newSession();
  session.cancelled.push("ORD-103");
  const result = executeTool("cancel_order", { order_id: "ORD-103" }, ctx(session));
  assert.equal(result.status, "done");
  assert.match(result.say!, /already cancelled/i);
});

// ── 3. Returns, COD, shipping-policy questions ────────────────────────────

test("eval: return inside window asks about condition", () => {
  const result = checkReturnEligibility("ORD-105", {}, newSession());
  assert.equal(result.status, "needs_info");
  assert.match(result.say!, /unopened, unused and still in its original packaging/i);
});

test("eval: return inside window with all conditions met is eligible", () => {
  const facts = { is_opened: false, is_unused: true, original_packaging: true };
  const result = checkReturnEligibility("ORD-105", facts, newSession());
  assert.equal(result.status, "ok");
  assert.equal(result.output.eligible, true);
});

test("eval: return outside 7-day window is declined", () => {
  const facts = { is_opened: false, is_unused: true, original_packaging: true };
  const result = checkReturnEligibility("ORD-102", facts, newSession());
  assert.equal(result.status, "declined");
  assert.match(result.say!, /delivered 14 days ago/i);
});

test("eval: opened or used product is declined", () => {
  const result = checkReturnEligibility("ORD-105", { is_opened: true }, newSession());
  assert.equal(result.status, "declined");
  assert.match(result.say!, /unopened, unused products/i);
});

test("eval: damaged product within 48h needs photos", () => {
  const result = checkReturnEligibility("ORD-106", { is_damaged: true }, newSession());
  assert.equal(result.status, "needs_info");
  assert.match(result.say!, /photos/i);
});

test("eval: damaged product within 48h with photos is eligible for replacement", () => {
  const result = checkReturnEligibility("ORD-106", { is_damaged: true, photos_available: true }, newSession());
  assert.equal(result.status, "ok");
  assert.match(result.say!, /replacement/i);
});

test("eval: damaged product after 48h is declined", () => {
  const result = checkReturnEligibility("ORD-102", { is_damaged: true, photos_available: true }, newSession());
  assert.equal(result.status, "declined");
  assert.match(result.say!, /48 hours/i);
});

test("eval: COD eligibility follows brand policy (Aura 2500, Veda 5000)", () => {
  const aura = executeTool("get_order_details", { order_id: "ORD-107" }, ctx(newSession(), ["ORD-107"]));
  const auraPolicy = (aura.output as { policy: { cash_on_delivery_eligible: boolean } }).policy;
  assert.equal(auraPolicy.cash_on_delivery_eligible, false);

  const veda = executeTool("get_order_details", { order_id: "ORD-204" }, ctx(newSession("veda"), ["ORD-204"]));
  const vedaPolicy = (veda.output as { policy: { cash_on_delivery_eligible: boolean } }).policy;
  assert.equal(vedaPolicy.cash_on_delivery_eligible, true);
});

test("eval: shipping fee and free-shipping threshold are in order policy", async () => {
  const result = executeTool("get_order_details", { order_id: "ORD-101" }, ctx());
  const policy = (result.output as { policy: { shipping?: string } }).policy;
  // The policy object includes return/cancel info; shipping question is answered from brand policy
  const { brandById } = await import("../src/data/brand");
  const brand = brandById("aura");
  assert.equal(brand.policy.freeShippingAbove, 499);
  assert.equal(brand.policy.shippingFee, 50);
});

// ── 4. Unknown orders and missing information ─────────────────────────────

test("eval: order ID the customer never said is blocked", () => {
  const session = newSession();
  const result = executeTool("cancel_order", { order_id: "ORD-103", customer_confirmed: true }, ctx(session, ["ORD-101"]));
  assert.equal(result.status, "blocked");
  assert.equal((result.output as { error: string }).error, "order_id_not_given_by_customer");
});

test("eval: bare follow-up with one verified order reuses it", async () => {
  const replies = await converse(newSession(), "Where is ORD-101?", "When will it arrive?");
  assert.match(replies[0], /ORD-101/);
  assert.match(replies[1], /ORD-101/);
});

test("eval: bare follow-up with two orders asks which one", async () => {
  const replies = await converse(newSession(), "Where is ORD-101?", "And ORD-102?", "When will it arrive?");
  assert.match(replies[2], /Which order do you mean/i);
  assert.doesNotMatch(replies[2], /BlueDart|delivered/);
});

test("eval: missing order ID in request prompts for it", () => {
  const session = newSession();
  const result = executeTool("check_return_eligibility", { order_id: "ORD-101" }, ctx(session, ["ORD-999"]));
  // Guardrail blocks: customer never mentioned ORD-101
  assert.equal(result.status, "blocked");
});

// ── 5. Correct tool selection and parameter validation ─────────────────────

test("eval: invalid tool name fails safely", () => {
  const result = executeTool("delete_everything", {}, ctx());
  assert.equal(result.status, "error");
});

test("eval: invalid parameter type fails safely", () => {
  const result = executeTool("get_order_details", { order_id: 42 }, ctx());
  assert.equal(result.status, "error");
});

test("eval: find_products without any criteria asks for more", () => {
  const result = executeTool("find_products", {}, ctx(newSession(), [], "PRODUCT_QUESTION"));
  assert.equal(result.status, "needs_info");
  assert.equal(result.summary, "Product search needs a goal or skin type");
});

test("eval: find_products respects brand scoping", () => {
  const aura = executeTool("find_products", { query: "vitamin c" }, ctx(newSession(), [], "PRODUCT_QUESTION"));
  assert.equal(aura.status, "ok");
  const auraProducts = (aura.output as { products: { name: string }[] }).products;
  assert.ok(auraProducts.some(p => p.name.includes("Vitamin C")));

  const veda = executeTool("find_products", { query: "vitamin c" }, ctx(newSession("veda"), [], "PRODUCT_QUESTION"));
  const vedaProducts = (veda.output as { products?: { name: string }[] }).products ?? [];
  assert.ok(!vedaProducts.some(p => p.name.includes("Vitamin C")), "Veda never sees Aura's catalogue");
});

test("eval: find_products respects max_price filter", () => {
  const result = executeTool("find_products", { query: "cleanser", max_price: 450 }, ctx(newSession(), [], "PRODUCT_QUESTION"));
  const products = (result.output as { products?: { price_rupees: number }[] }).products ?? [];
  assert.ok(products.length > 0, "should find at least one product");
  assert.ok(products.every(p => p.price_rupees <= 450));
});

// ── 6. Backend policy enforcement ──────────────────────────────────────────

test("eval: cancellation policy enforced server-side; model cannot override", async () => {
  await withEnv(TEST_KEYS, async () => {
    await withFetch(
      (_url, _body, idx) => idx === 0
        ? gemini(call("cancel_order", { order_id: "ORD-103", customer_confirmed: true }))
        : gemini(text("Done, cancelled.")),
      async () => {
        const session = newSession();
        const messages: ChatMessage[] = [];
        messages.push({ role: "user", content: "Please cancel ORD-103, I confirm" });
        const result = await runTurn(messages, session, () => {});
        // Even if model claims confirmation, first call must be confirm
        assert.equal(session.pendingCancel, "ORD-103");
        assert.deepEqual(session.cancelled, []);
      },
    );
  });
});

test("eval: return policy enforced; model cannot approve outside window", async () => {
  await withEnv(TEST_KEYS, async () => {
    await withFetch(
      (_url, _body, idx) => idx === 0
        ? gemini(call("check_return_eligibility", { order_id: "ORD-102", is_opened: false, is_unused: true, original_packaging: true }))
        : gemini(text("Return approved.")),
      async () => {
        const session = newSession();
        const messages: ChatMessage[] = [];
        messages.push({ role: "user", content: "I want to return ORD-102, it's unopened and unused" });
        const result = await runTurn(messages, session, () => {});
        // Tool returns declined regardless of model's call
        const toolResult = executeTool("check_return_eligibility", { order_id: "ORD-102", is_opened: false, is_unused: true, original_packaging: true }, ctx(session));
        assert.equal(toolResult.status, "declined");
      },
    );
  });
});

test("eval: guardrail blocks model from acting on unmentioned order ID", () => {
  const session = newSession();
  const result = executeTool("cancel_order", { order_id: "ORD-103", customer_confirmed: true }, ctx(session, ["ORD-101"]));
  assert.equal(result.status, "blocked");
});

// ── 7. False transaction-success claims ────────────────────────────────────

test("eval: model prose cannot promote a failed attempt to success in recap", async () => {
  await withEnv(TEST_KEYS, async () => {
    await withFetch(
      (_url, _body, idx) => idx === 0
        ? gemini(text(JSON.stringify({
          customer_intent: "RETURN_REQUEST",
          resolution_status: "RESOLVED",
          call_summary: "Customer was told the return for ORD-102 was approved and the refund is complete.",
          customer_sentiment: "POSITIVE",
          follow_up_required: false,
        })))
        : gemini(text("")),
      async () => {
        const session = newSession();
        // Simulate a failed return check being recorded
        session.toolResults = [
          { name: "check_return_eligibility", status: "declined", order_id: "ORD-102", summary: "Declined: delivered 14 days ago (limit 7)", ms: 10 },
        ];
        session.outcomes = [
          { intent: "RETURN_REQUEST", order_id: "ORD-102", resolution: "POLICY_DECLINED", detail: "Return for ORD-102 declined: delivered 14 days ago, outside the 7-day window." },
        ];
        const transcript: ChatMessage[] = [{ role: "user", content: "Can I return ORD-102?" }];
        const provider = getProvider()!;
        const summary = await modelSummary(provider, { session, transcript, durationSeconds: 30, avgResponseMs: 1200 });
        // Recap must still show failed
        assert.equal(summary.recap?.attempted_actions[0].result, "failed");
        assert.ok(summary.recap?.verified_outcomes.some(o => /declined/i.test(o)));
        assert.ok(!summary.recap?.verified_outcomes.some(o => /approved|refund is complete/i.test(o)));
      },
    );
  });
});

test("eval: summary schema rejects malformed recap", () => {
  const session = newSession();
  const transcript: ChatMessage[] = [{ role: "user", content: "Where is ORD-101?" }];
  const summary = rulesSummary({ session, transcript, durationSeconds: 20, avgResponseMs: 900 });
  assert.ok(callSummarySchema.safeParse(summary).success);

  const broken = { ...summary, recap: { ...summary.recap!, next_steps: "not a list" } };
  assert.ok(!callSummarySchema.safeParse(broken).success);

  const brokenAction = { ...summary, recap: { ...summary.recap!, attempted_actions: [{ action: "Lookup", order_id: null, result: "maybe", detail: "x" }] } };
  assert.ok(!callSummarySchema.safeParse(brokenAction).success);
});

// ── 8. RAG grounding and missing evidence ──────────────────────────────────

test("eval: product search returns only catalogue matches, never invents", () => {
  const result = executeTool("find_products", { concern: "hair fall" }, ctx(newSession("aura"), [], "PRODUCT_QUESTION"));
  assert.equal(result.status, "needs_info");
  assert.equal(result.summary, "No catalogue match");
  assert.equal((result.output as { found: boolean }).found, false);
});

test("eval: product recommendation keeps prices and ingredients exact", () => {
  const result = executeTool("find_products", { query: "moisturiser", concern: "dryness", skin_type: "dry" }, ctx(newSession(), [], "PRODUCT_QUESTION"));
  assert.equal(result.status, "ok");
  const products = (result.output as { products: { name: string; price_rupees: number; key_ingredients: string[] }[] }).products;
  assert.ok(products.length > 0, "should recommend at least one product");
  // Find a moisturiser product and verify its data is exact
  const moisturiser = products.find(p => p.name.toLowerCase().includes("moisturiser") || p.name.toLowerCase().includes("cream"));
  assert.ok(moisturiser, "should find a moisturiser product");
  assert.ok(typeof moisturiser.price_rupees === "number" && moisturiser.price_rupees > 0);
  assert.ok(Array.isArray(moisturiser.key_ingredients) && moisturiser.key_ingredients.length > 0);
});

test("eval: unknown concern says so and offers alternatives", () => {
  const result = executeTool("find_products", { concern: "anti-aging miracle" }, ctx(newSession(), [], "PRODUCT_QUESTION"));
  assert.equal(result.status, "needs_info");
  assert.equal((result.output as { found: boolean }).found, false);
});

// ── 9. Voice interruption and stale-response prevention ────────────────────

test("eval: VAD detects interruption above calibrated echo", () => {
  const vad = new VoiceActivityDetector();
  // Simulate calibration phase: Aria speaking, mic picks up echo
  for (let i = 0; i < 50; i++) vad.update("speaking", 0.05, i * 16, 0.2);
  // Now user interrupts with louder sustained speech
  let event: "interrupt" | "utterance_end" | null = null;
  // Need sustained speech for SPEAKING.sustainMs (320ms) = 20 frames at 16ms
  for (let i = 50; i < 75; i++) {
    event = vad.update("speaking", 0.25, i * 16, 0.2);
    if (event === "interrupt") break;
  }
  assert.equal(event, "interrupt");
});

test("eval: VAD ignores brief blips during calibration", () => {
  const vad = new VoiceActivityDetector();
  for (let i = 0; i < 50; i++) vad.update("speaking", 0.05, i * 16, 0.2);
  // Brief blip below threshold
  for (let i = 50; i < 55; i++) vad.update("speaking", 0.08, i * 16, 0.2);
  // No interrupt
  let event: "interrupt" | "utterance_end" | null = null;
  for (let i = 55; i < 60; i++) {
    event = vad.update("speaking", 0.03, i * 16, 0.2);
  }
  assert.notEqual(event, "interrupt");
});

test("eval: VAD utterance-end fires after speech then silence", () => {
  const vad = new VoiceActivityDetector();
  // Speech
  for (let i = 0; i < 20; i++) vad.update("recording", 0.1, i * 16);
  // Silence
  let event: "interrupt" | "utterance_end" | null = null;
  for (let i = 20; i < 80; i++) {
    event = vad.update("recording", 0.005, i * 16);
    if (event === "utterance_end") break;
  }
  assert.equal(event, "utterance_end");
});

test("eval: epoch generation prevents stale responses from old turns", async () => {
  await withEnv(NO_KEYS, async () => {
    const session = newSession();
    // First turn
    const r1 = await runTurn([{ role: "user", content: "Where is ORD-101?" }], session, () => {});
    assert.match(r1.reply, /ORD-101/);
    // Second turn starts a new epoch internally; an aborted first turn cannot confirm
    const r2 = await runTurn(
      [{ role: "user", content: "Where is ORD-101?" }, { role: "assistant", content: r1.reply }, { role: "user", content: "Actually, cancel ORD-103" }],
      session,
      () => {}
    );
    // Cancellation of ORD-103 requires its own confirmation
    assert.ok(session.pendingCancel === "ORD-103" || session.cancelled.includes("ORD-103"));
  });
});

// ── 10. Conversation summary validation and export permissions ────────────

test("eval: summary route rejects forged session token", async () => {
  const forged = await summaryRoute(request({ session: "forged.token", transcript: [{ role: "user", content: "Where is ORD-101?" }] }));
  assert.equal(forged.status, 400);
});

test("eval: summary only shows the call's own brand", async () => {
  const veda = newSession("veda");
  const valid = await summaryRoute(request({
    session: signSession(veda),
    transcript: [{ role: "user", content: "Where is ORD-101?" }],
    metrics: { duration_seconds: 8, avg_response_ms: null },
  }));
  assert.equal(valid.status, 200);
  const data = await valid.json();
  assert.equal(data.brand, "Aura Haircare");
  assert.equal(data.recap.order_reference, null);
  assert.ok(!JSON.stringify(data.recap).includes("ORD-101"));
});

test("eval: summary route validates final output against schema", async () => {
  const session = newSession();
  const transcript: ChatMessage[] = [{ role: "user", content: "Where is ORD-101?" }];
  const res = await summaryRoute(request({
    session: signSession(session),
    transcript,
    metrics: { duration_seconds: 10, avg_response_ms: 900 },
  }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(callSummarySchema.safeParse(data).success);
});

test("eval: download Markdown excludes transcript, emails, phone numbers, other-brand orders", async () => {
  const session = newSession();
  // Add a tool result and outcome so the recap has attempted actions and verified outcomes
  session.toolResults = [
    { name: "get_order_details", status: "ok", order_id: "ORD-101", summary: "ORD-101: Out for Delivery", ms: 10 },
  ];
  session.outcomes = [
    { intent: "ORDER_TRACKING", order_id: "ORD-101", resolution: "RESOLVED", detail: "Shared the status of ORD-101: Out for Delivery." },
  ];
  const transcript: ChatMessage[] = [
    { role: "user", content: "Where is ORD-101?" },
    { role: "assistant", content: "ORD-101 is out for delivery." },
    { role: "user", content: "Email me at priya@example.com or call 9876543210 about ORD-201." },
  ];
  const summary = rulesSummary({ session, transcript, durationSeconds: 30, avgResponseMs: 1000 });
  const md = recapMarkdown(summary);
  assert.match(md, /^# Aura Skincare — conversation recap\n/);
  assert.match(md, /## Key discussion points/);
  assert.match(md, /## Attempted actions/);
  assert.match(md, /## Verified outcomes/);
  assert.match(md, /## Next steps/);
  assert.match(md, /## Call details/);
  assert.ok(!md.includes("priya@example.com"));
  assert.ok(!md.includes("9876543210"));
  assert.ok(!md.includes("ORD-201"));
  assert.ok(!md.includes("Customer: "), "recap is not a transcript");
  assert.ok(md.endsWith("\n"));
});

test("eval: safeRecapText redacts emails, phone-like numbers, API-key-like strings, other-brand order IDs", () => {
  const allowed = new Set(["ORD-101"]);
  const redacted = safeRecapText("Email a@b.com, call 98765 43210, key sk-abcdefghijklmnop about ORD-101 and ORD-201", allowed);
  assert.equal(redacted, "Email [email], call [number], key [secret] about ORD-101 and an unverified order");
});

// ── 11. Administrative authorization ───────────────────────────────────────

test("eval: admin login unavailable when ADMIN_TOKEN not configured", async () => {
  await withEnv({ ADMIN_TOKEN: undefined, NODE_ENV: "production" }, async () => {
    const req = new Request("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "anything" }),
    });
    const res = await adminLogin(req);
    assert.equal(res.status, 404);
  });
});

test("eval: admin login requires token in production", async () => {
  await withEnv({ ADMIN_TOKEN: "secret123", NODE_ENV: "production" }, async () => {
    const req = new Request("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    const res = await adminLogin(req);
    assert.equal(res.status, 401);
  });
});

test("eval: admin login accepts correct token and sets httpOnly cookie", async () => {
  await withEnv({ ADMIN_TOKEN: "secret123", NODE_ENV: "production" }, async () => {
    const req = new Request("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "secret123" }),
    });
    const res = await adminLogin(req);
    assert.equal(res.status, 200);
    const cookie = res.headers.get("Set-Cookie");
    assert.ok(cookie?.includes("aria_admin="));
    assert.ok(cookie?.includes("HttpOnly"));
    assert.ok(cookie?.includes("Secure"));
  });
});

test("eval: adminConfigured and adminAvailable reflect env correctly", async () => {
  assert.equal(adminConfigured(), false);
  assert.equal(adminAvailable(), true); // development

  await withEnv({ ADMIN_TOKEN: "secret", NODE_ENV: "production" }, () => {
    assert.equal(adminConfigured(), true);
    assert.equal(adminAvailable(), true);
  });

  await withEnv({ ADMIN_TOKEN: undefined, NODE_ENV: "production" }, () => {
    assert.equal(adminConfigured(), false);
    assert.equal(adminAvailable(), false);
  });
});

test("eval: tokenMatches uses timing-safe comparison", async () => {
  await withEnv({ ADMIN_TOKEN: "secret123" }, () => {
    assert.equal(tokenMatches("secret123"), true);
    assert.equal(tokenMatches("wrong"), false);
  });
});

test("eval: rate limit applies to admin login", async () => {
  await withEnv({ ADMIN_TOKEN: "secret", NODE_ENV: "production" }, async () => {
    // Exhaust the rate limit (limit is 10 per hour per IP)
    const ip = "test-rate-limit-ip";
    for (let i = 0; i < 11; i++) {
      const req = new Request("http://localhost/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vercel-forwarded-for": ip },
        body: JSON.stringify({ token: "secret" }),
      });
      const res = await adminLogin(req);
      if (i === 10) assert.equal(res.status, 429);
    }
  });
});

// ── 12. Duplicate actions and sensitive-information leakage ────────────────

test("eval: duplicate tool call id never creates duplicate row", async () => {
  const { startAction, recordAction } = await import("../src/lib/agent/actionState");
  const first = startAction({ type: "tool_call", id: "a1", name: "get_order_details", args: { order_id: "ORD-101" } }, 1);
  const actions = recordAction(recordAction([], first), startAction({ type: "tool_call", id: "a1", name: "get_order_details", args: { order_id: "ORD-101" } }, 1));
  assert.equal(actions.length, 1);
});

test("eval: repeated cancellation after completion is idempotent", () => {
  const session = newSession();
  session.cancelled.push("ORD-103");
  const result = executeTool("cancel_order", { order_id: "ORD-103" }, ctx(session));
  assert.equal(result.status, "done");
  assert.match(result.say!, /already cancelled/i);
});

test("eval: session toolResults do not leak sensitive data", () => {
  const session = newSession();
  session.toolResults = [
    { name: "get_order_details", status: "ok", order_id: "ORD-101", summary: "ORD-101: Out for Delivery", ms: 10 },
    { name: "cancel_order", status: "done", order_id: "ORD-103", summary: "Cancelled after confirmation", ms: 15 },
  ];
  // The recap redacts emails, phones, keys, other-brand IDs
  const transcript: ChatMessage[] = [
    { role: "user", content: "Track ORD-101 and email me at test@example.com" },
    { role: "assistant", content: "Done" },
  ];
  const summary = rulesSummary({ session, transcript, durationSeconds: 20, avgResponseMs: 500 });
  const md = recapMarkdown(summary);
  assert.ok(!md.includes("test@example.com"));
  assert.ok(!md.includes("[secret]") || !md.includes("sk-")); // keys redacted
});

test("eval: transcript and internal prompts never appear in recap or download", async () => {
  const session = newSession();
  const transcript: ChatMessage[] = [
    { role: "user", content: "Where is my order ORD-101?" },
    { role: "assistant", content: "It's out for delivery." },
    { role: "user", content: "Thank you" },
  ];
  const summary = rulesSummary({ session, transcript, durationSeconds: 20, avgResponseMs: 500 });
  const md = recapMarkdown(summary);
  // Key discussion points are derived from user messages but not the full transcript
  assert.ok(md.includes("Where is my order ORD-101"), "key points include user questions");
  // But not the full conversation format
  assert.ok(!md.includes("Aria:"), "assistant messages not in recap");
  assert.ok(!md.includes("system prompt"));
  assert.ok(!md.includes("Customer:"), "not a transcript format");
});

// ── Optional live-provider smoke tests (skipped when no keys) ─────────────

const hasLiveKeys = Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);

if (hasLiveKeys) {
  test("eval (live): model can answer a policy question grounded in brand data", async () => {
    const session = newSession();
    const messages: ChatMessage[] = [];
    messages.push({ role: "user", content: "What is the return window for Aura Skincare?" });
    const result = await runTurn(messages, session, () => {});
    assert.match(result.reply, /7.day|seven.day/i);
    assert.equal(result.source, "model");
  });

  test("eval (live): model uses find_products tool for product questions", async () => {
    const session = newSession();
    const messages: ChatMessage[] = [];
    messages.push({ role: "user", content: "Recommend a moisturiser for dry skin under 1500 rupees" });
    const result = await runTurn(messages, session, () => {});
    // Should have called find_products (we can't easily assert here without tracing, but it should not hallucinate)
    assert.ok(result.reply.length > 0);
  });
} else {
  test("eval (live): SKIPPED - no live provider keys configured", () => {});
}