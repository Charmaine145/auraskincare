import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn } from "../src/lib/agent/agent";
import { getProvider } from "../src/lib/agent/providers";
import { newSession, readSession, signSession } from "../src/lib/session";
import { mergeIssues, modelSummary, rulesSummary } from "../src/lib/summary";
import type { ChatMessage } from "../src/types";
import { gemini, text, withEnv, withFetch } from "./helpers";

async function demoCall(...lines: string[]) {
  const session = newSession();
  const transcript: ChatMessage[] = [];
  await withEnv({ GEMINI_API_KEY: undefined, OPENAI_API_KEY: undefined }, async () => {
    for (const line of lines) {
      transcript.push({ role: "user", content: line });
      const result = await runTurn(transcript, session, () => {});
      transcript.push({ role: "assistant", content: result.reply });
    }
  });
  return { session, transcript };
}

test("single-issue call matches the brief's example shape", async () => {
  const { session, transcript } = await demoCall("Where is my order ORD-101?");
  const summary = rulesSummary({ session, transcript, durationSeconds: 42, avgResponseMs: 1800 });
  assert.equal(summary.customer_intent, "ORDER_TRACKING");
  assert.equal(summary.order_id, "ORD-101");
  assert.equal(summary.resolution_status, "RESOLVED");
  assert.match(summary.call_summary, /^Customer called about the status of an order\. Shared the status of ORD-101: Out for Delivery via BlueDart/);
  assert.deepEqual(summary.metrics, { customer_turns: 1, tool_calls: 1, duration_seconds: 42, avg_response_ms: 1800 });
});

test("multi-issue call keeps a primary intent plus every issue", async () => {
  const { session, transcript } = await demoCall("Where is ORD-101?", "Can I return ORD-102?", "Cancel ORD-103", "yes", "Can you book a flight?");
  const summary = rulesSummary({ session, transcript, durationSeconds: null, avgResponseMs: null });
  assert.equal(summary.customer_intent, "ORDER_TRACKING");
  assert.equal(summary.order_id, "ORD-101");
  assert.deepEqual(summary.issues.map(i => `${i.intent}:${i.order_id}:${i.resolution}`), [
    "ORDER_TRACKING:ORD-101:RESOLVED",
    "RETURN_REQUEST:ORD-102:POLICY_DECLINED",
    "CANCELLATION:ORD-103:RESOLVED",
    "OUT_OF_SCOPE:null:POLICY_DECLINED",
  ]);
  assert.deepEqual(summary.actions_taken, ["Cancelled ORD-103 after the customer confirmed"]);
  assert.deepEqual(summary.order_ids, ["ORD-101", "ORD-102", "ORD-103"]);
});

test("asking for an ID and then getting it is one issue", () => {
  const issues = mergeIssues([
    { intent: "CANCELLATION", order_id: null, resolution: "NEEDS_INFORMATION", detail: "Asked the customer for their order ID." },
    { intent: "CANCELLATION", order_id: "ORD-103", resolution: "NEEDS_INFORMATION", detail: "Asked to confirm." },
    { intent: "CANCELLATION", order_id: "ORD-103", resolution: "RESOLVED", detail: "Cancelled." },
  ]);
  assert.deepEqual(issues, [{ intent: "CANCELLATION", order_id: "ORD-103", resolution: "RESOLVED" }]);
});

test("an empty call is reported as such", () => {
  const summary = rulesSummary({ session: newSession(), transcript: [{ role: "assistant", content: "Hi, I'm Aria." }], durationSeconds: 5, avgResponseMs: null });
  assert.equal(summary.resolution_status, "NO_CONVERSATION");
});

test("model summary: narrative from Gemini, facts from the verified log", async () => {
  const { session, transcript } = await demoCall("Can I return ORD-102?");
  await withEnv({ GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-3.5-flash-lite" }, () =>
    withFetch(
      () => gemini(text(JSON.stringify({ customer_intent: "RETURN_REQUEST", resolution_status: "POLICY_DECLINED", call_summary: "Customer asked to return ORD-102; Aria declined because it was delivered 14 days ago.", customer_sentiment: "NEUTRAL", follow_up_required: false }))),
      async calls => {
        const summary = await modelSummary(getProvider()!, { session, transcript, durationSeconds: 30, avgResponseMs: 1500 });
        assert.equal(summary.generated_by, "gemini-3.5-flash-lite");
        assert.equal(summary.order_id, "ORD-102");
        assert.equal(summary.resolution_status, "POLICY_DECLINED");
        assert.equal(calls[0].body.generationConfig.responseMimeType, "application/json");
        assert.ok(calls[0].body.generationConfig.responseJsonSchema.properties.customer_intent.enum.includes("RETURN_REQUEST"));
        assert.match(calls[0].body.contents[0].parts[0].text, /RETURN_REQUEST · ORD-102 · POLICY_DECLINED/);
      },
    ));
});

test("model summary is rejected if it invents an order or breaks the schema", async () => {
  const { session, transcript } = await demoCall("Where is ORD-101?");
  await withEnv({ GEMINI_API_KEY: "test-key" }, async () => {
    await withFetch(
      () => gemini(text(JSON.stringify({ customer_intent: "ORDER_TRACKING", resolution_status: "RESOLVED", call_summary: "Customer asked about ORD-555, which is on its way.", customer_sentiment: "NEUTRAL", follow_up_required: false }))),
      () => assert.rejects(modelSummary(getProvider()!, { session, transcript, durationSeconds: null, avgResponseMs: null }), /not discussed/),
    );
    await withFetch(
      () => gemini(text(JSON.stringify({ customer_intent: "SOMETHING_ELSE", resolution_status: "RESOLVED", call_summary: "Customer asked about ORD-101.", customer_sentiment: "NEUTRAL", follow_up_required: false }))),
      () => assert.rejects(modelSummary(getProvider()!, { session, transcript, durationSeconds: null, avgResponseMs: null })),
    );
  });
});

test("call state is signed: tampering, expiry and old versions are rejected", () => {
  const data = newSession();
  data.cancelled.push("ORD-103");
  assert.deepEqual(readSession(signSession(data)), data);
  const [payload, signature] = signSession(data).split(".");
  const forged = Buffer.from(JSON.stringify({ ...data, cancelled: ["ORD-101"] })).toString("base64url");
  assert.throws(() => readSession(`${forged}.${signature}`), /Invalid call session/);
  assert.throws(() => readSession(`${payload}x.${signature}`), /Invalid call session/);
  assert.throws(() => readSession(signSession({ ...data, expires: 0 })), /expired/);
  assert.throws(() => readSession(signSession({ ...data, v: 1 } as unknown as typeof data)), /older version/);
});
