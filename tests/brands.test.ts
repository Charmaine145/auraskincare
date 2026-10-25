import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as chat } from "../src/app/api/chat/route";
import { POST as summary } from "../src/app/api/summary/route";
import { BRANDS, brandById, brandKnowledge, sampleIds } from "../src/data/brand";
import { systemPrompt } from "../src/lib/agent/prompt";
import { checkReturnEligibility, executeTool, type ToolContext } from "../src/lib/agent/tools";
import { readNdjson } from "../src/lib/ndjson";
import { newSession, readSession, signSession } from "../src/lib/session";
import { greetingFor } from "../src/lib/voice/languages";
import type { ChatStreamEvent, SessionData } from "../src/types";
import { withEnv } from "./helpers";

const ctx = (session: SessionData, ids: string[]): ToolContext => ({ session, mentionedIds: new Set(ids), intent: "ORDER_TRACKING" });
const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "x-vercel-forwarded-for": crypto.randomUUID() }, body: JSON.stringify(body) });
const facts = { is_opened: false, is_unused: true, original_packaging: true };

test("a call only sees its own brand's orders", () => {
  const veda = newSession("veda");
  assert.equal(executeTool("get_order_details", { order_id: "ORD-101" }, ctx(veda, ["ORD-101"])).status, "not_found", "Aura's order doesn't exist for Veda");
  assert.equal(executeTool("get_order_details", { order_id: "ORD-201" }, ctx(veda, ["ORD-201"])).status, "ok");
  assert.equal(executeTool("get_order_details", { order_id: "ORD-201" }, ctx(newSession("aura"), ["ORD-201"])).status, "not_found");
});

test("the same policy engine applies each brand's own numbers", () => {
  // Returns: 9 days after delivery is fine at Veda (10-day window), not at Aura (7).
  assert.equal(checkReturnEligibility("ORD-202", facts, newSession("veda")).status, "ok");
  assert.match(checkReturnEligibility("ORD-102", facts, newSession("aura")).say ?? "", /within 7 days/);

  // Damage: 3 days after delivery is inside Veda's 72 hours, outside Aura's 48.
  assert.equal(checkReturnEligibility("ORD-205", { is_damaged: true }, newSession("veda")).status, "needs_info");
  const aura = checkReturnEligibility("ORD-105", { is_damaged: true }, newSession("aura"));
  assert.equal(aura.status, "declined");
  assert.match(aura.say ?? "", /within 48 hours/);

  // Cash on Delivery: 4,200 rupees is under Veda's 5,000 limit.
  const kit = executeTool("get_order_details", { order_id: "ORD-204" }, ctx(newSession("veda"), ["ORD-204"])).output as { policy: { cash_on_delivery_eligible: boolean; returns: string } };
  assert.equal(kit.policy.cash_on_delivery_eligible, true);

  // Care-team references carry the brand's prefix.
  const escalation = executeTool("escalate_to_human", { reason: "Wants a person" }, ctx(newSession("veda"), []));
  assert.match(String(escalation.output.reference), /^VED-\d{4}$/);
});

test("a call stays with the brand it started with", () => {
  const token = signSession(newSession("veda"));
  assert.equal(readSession(token).brand, "veda");
  assert.equal(readSession(token, "veda").brand, "veda");
  assert.throws(() => readSession(token, "aura"), /different brand/);
  assert.equal(readSession(undefined, "veda").brand, "veda", "a new call takes the requested brand");
  const legacy = signSession({ ...newSession(), brand: undefined });
  assert.equal(brandById(readSession(legacy).brand).id, "aura", "tokens from before multi-brand are Aura's");
});

test("prompt, greetings and knowledge are the brand's own", () => {
  const veda = BRANDS.veda;
  assert.equal(BRANDS.aura.name, "Aura Skincare");
  assert.equal(veda.name, "Aura Haircare");
  assert.equal(veda.wordmark, "Aura Haircare");
  const prompt = systemPrompt(veda);
  assert.match(prompt, /specialist for Aura Haircare/);
  assert.match(prompt, /within 10 days of delivery/);
  assert.match(prompt, /5,000 rupees/);
  assert.doesNotMatch(prompt, /Aura Skincare/);
  assert.match(brandKnowledge(BRANDS.aura), /within 7 days.*[\s\S]*48 hours[\s\S]*2,500 rupees/, "Aura keeps the brief's numbers");
  assert.match(greetingFor("hi-IN", "veda"), /ऑरा हेयरकेयर/);
  assert.match(greetingFor("en-IN", "aura"), /Aura Skincare/);
  assert.equal(greetingFor("xx-XX", "veda"), veda.greetings["en-IN"]);
  for (const brand of Object.values(BRANDS)) {
    for (const id of Object.values(sampleIds(brand))) assert.ok(brand.orders.some(o => o.order_id === id), `${brand.id} sample ${id} exists`);
  }
});

test("chat binds a new call to the requested brand, and the summary names it", () =>
  withEnv({ GEMINI_API_KEY: undefined, OPENAI_API_KEY: undefined }, async () => {
    const response = await chat(post("http://localhost/api/chat", { brand: "veda", messages: [{ role: "user", content: "Where is ORD-201?" }] }));
    const stream: ChatStreamEvent[] = [];
    for await (const event of readNdjson<ChatStreamEvent>(response.body!)) stream.push(event);
    const reply = stream.find(e => e.type === "reply") as Extract<ChatStreamEvent, { type: "reply" }>;
    assert.match(reply.text, /Bhringraj Hair Oil/);
    const done = stream.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;

    // Continuing the call as another brand is refused.
    const switched = await chat(post("http://localhost/api/chat", { brand: "aura", session: done.session, messages: [{ role: "user", content: "Where is ORD-101?" }] }));
    assert.equal(switched.status, 400);

    const record = await (await summary(post("http://localhost/api/summary", {
      session: done.session,
      transcript: [{ role: "user", content: "Where is ORD-201?" }, { role: "assistant", content: reply.text }],
    }))).json();
    assert.equal(record.brand, "Aura Haircare");
    assert.equal(record.order_id, "ORD-201");
  }));
