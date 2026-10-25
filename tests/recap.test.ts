import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as summaryRoute } from "../src/app/api/summary/route";
import { runTurn } from "../src/lib/agent/agent";
import { getProvider } from "../src/lib/agent/providers";
import { recapMarkdown, safeRecapText } from "../src/lib/recap";
import { newSession, signSession } from "../src/lib/session";
import { callSummarySchema, modelSummary, rulesSummary } from "../src/lib/summary";
import type { ChatMessage, SessionData } from "../src/types";
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

const summaryOf = (session: SessionData, transcript: ChatMessage[]) =>
  rulesSummary({ session, transcript, durationSeconds: 20, avgResponseMs: 900 });

test("recap: a lookup comes from verified results with an authorised order reference", async () => {
  const { session, transcript } = await demoCall("Where is my order ORD-101?");
  const summary = summaryOf(session, transcript);
  const recap = summary.recap!;

  assert.equal(recap.issue, "Order status for ORD-101.");
  assert.equal(recap.order_reference, "ORD-101");
  assert.deepEqual(recap.key_points, ["Where is my order ORD-101?"]);
  assert.deepEqual(recap.attempted_actions.map(a => [a.action, a.order_id, a.result]), [["Order lookup", "ORD-101", "confirmed"]]);
  assert.ok(recap.attempted_actions[0].detail.includes("Out for Delivery"));
  assert.ok(recap.verified_outcomes.some(outcome => outcome.includes("Shared the status of ORD-101")));
  assert.deepEqual(recap.unresolved_issues, []);
  assert.deepEqual(recap.next_steps, ["No further action is needed."]);
});

test("recap: a cancellation is unconfirmed until the server actually completes it", async () => {
  const asked = await demoCall("Please cancel ORD-103.");
  const pending = summaryOf(asked.session, asked.transcript).recap!;

  assert.equal(pending.order_reference, "ORD-103");
  assert.equal(pending.attempted_actions.at(-1)?.action, "Cancellation check");
  assert.equal(pending.attempted_actions.at(-1)?.result, "unconfirmed");
  assert.ok(pending.unresolved_issues.some(issue => /waiting for the customer's confirmation/i.test(issue)));
  assert.ok(pending.next_steps.includes("Confirm or decline the cancellation of ORD-103. Nothing has been changed yet."));
  assert.ok(!pending.verified_outcomes.some(outcome => /^Cancelled ORD-103/.test(outcome)));

  const confirmed = await demoCall("Please cancel ORD-103.", "Yes, please go ahead.");
  const done = summaryOf(confirmed.session, confirmed.transcript).recap!;

  assert.deepEqual(done.attempted_actions.map(a => a.result), ["unconfirmed", "confirmed"]);
  assert.equal(done.attempted_actions.at(-1)?.action, "Cancellation");
  assert.ok(done.verified_outcomes.includes("Cancelled ORD-103 after the customer confirmed."));
  assert.ok(!done.unresolved_issues.some(issue => /waiting for the customer's confirmation/i.test(issue)), "a completed cancellation is no longer unresolved");
  assert.ok(!done.next_steps.some(step => /Confirm or decline/.test(step)));
});

test("recap: model prose cannot promote a failed attempt or invent a transaction", async () => {
  const { session, transcript } = await demoCall("Can I return ORD-102?");
  await withEnv({ GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-3.5-flash-lite" }, () =>
    withFetch(
      () => gemini(text(JSON.stringify({
        customer_intent: "RETURN_REQUEST",
        resolution_status: "RESOLVED",
        call_summary: "Customer was told the return for ORD-102 was approved and the refund is complete.",
        customer_sentiment: "POSITIVE",
        follow_up_required: false,
      }))),
      async () => {
        const summary = await modelSummary(getProvider()!, { session, transcript, durationSeconds: 30, avgResponseMs: 1200 });
        assert.equal(summary.generated_by, "gemini-3.5-flash-lite");
        assert.equal(summary.recap?.attempted_actions[0].result, "failed");
        assert.ok(summary.recap?.verified_outcomes.some(outcome => /declined/i.test(outcome)));
        assert.ok(!summary.recap?.verified_outcomes.some(outcome => /approved|refund is complete|cancelled/i.test(outcome)));
      },
    ));
});

test("recap: malformed structured output is rejected", async () => {
  const { session, transcript } = await demoCall("Where is ORD-101?");
  const summary = summaryOf(session, transcript);
  assert.equal(callSummarySchema.safeParse(summary).success, true);

  const brokenRecap = { ...summary, recap: { ...summary.recap!, next_steps: "not a list" } };
  assert.equal(callSummarySchema.safeParse(brokenRecap).success, false);

  const brokenAction = { ...summary, recap: { ...summary.recap!, attempted_actions: [{ action: "Lookup", order_id: null, result: "maybe", detail: "x" }] } };
  assert.equal(callSummarySchema.safeParse(brokenAction).success, false);
});

test("recap: the download is readable Markdown and excludes sensitive detail", async () => {
  const { session, transcript } = await demoCall("Where is ORD-101?");
  transcript.push({ role: "user", content: "Email priya@example.com or call 9876543210 about ORD-201." });
  const markdown = recapMarkdown(summaryOf(session, transcript));

  assert.match(markdown, /^# Aura Skincare — conversation recap\n/);
  assert.match(markdown, /## Key discussion points/);
  assert.match(markdown, /## Attempted actions/);
  assert.match(markdown, /## Verified outcomes/);
  assert.match(markdown, /## Next steps/);
  assert.match(markdown, /## Call details/);
  assert.match(markdown, /Transaction statuses above come from the server record/);
  assert.ok(!markdown.includes("priya@example.com"));
  assert.ok(!markdown.includes("9876543210"));
  assert.ok(!markdown.includes("ORD-201"), "another brand's order is never exposed");
  assert.ok(!markdown.includes("Customer: "), "the recap is not a transcript");
  assert.ok(markdown.endsWith("\n"));
});

test("recap: another brand's order is withheld from every recap field", () => {
  const session = newSession("veda");
  session.toolResults = [{ name: "get_order_details", status: "not_found", order_id: "ORD-101", summary: "No order ORD-101 in the database", ms: 1 }];
  session.outcomes = [{ intent: "ORDER_TRACKING", order_id: "ORD-101", resolution: "NEEDS_INFORMATION", detail: "Order ID ORD-101 was not found; asked the customer to verify it." }];
  const summary = summaryOf(session, [{ role: "user", content: "Where is ORD-101?" }]);

  assert.equal(summary.recap?.order_reference, null);
  assert.ok(!JSON.stringify(summary.recap).includes("ORD-101"));
  assert.ok(!recapMarkdown(summary).includes("ORD-101"));
  assert.ok(JSON.stringify(summary.recap).includes("an unverified order"));
});

test("recap: empty and interrupted calls still produce honest guidance", () => {
  const empty = rulesSummary({ session: newSession(), transcript: [{ role: "assistant", content: "Hi, I'm Aria." }], durationSeconds: 4, avgResponseMs: null });
  assert.equal(empty.recap?.issue, "No customer request was recorded before the call ended.");
  assert.deepEqual(empty.recap?.next_steps, ["No follow-up is needed; the call ended before a request was made."]);

  const interrupted = newSession();
  interrupted.pendingCancel = "ORD-103";
  interrupted.toolResults = [{ name: "cancel_order", status: "confirm", order_id: "ORD-103", summary: "Eligible: waiting for the customer's confirmation", ms: 1 }];
  interrupted.outcomes = [{ intent: "CANCELLATION", order_id: "ORD-103", resolution: "NEEDS_INFORMATION", detail: "Asked the customer to confirm cancelling ORD-103." }];
  const summary = summaryOf(interrupted, [
    { role: "user", content: "Please cancel ORD-103." },
    { role: "assistant", content: "Shall I go ahead?" },
  ]);
  assert.ok(summary.recap?.unresolved_issues.some(issue => /no change has been made/i.test(issue)));
  assert.ok(summary.recap?.next_steps.includes("Confirm or decline the cancellation of ORD-103. Nothing has been changed yet."));
});

test("recap: the summary route rejects a forged session and only shows the call's own brand", async () => {
  const request = (body: unknown) => new Request("http://localhost/api/summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const forged = await summaryRoute(request({ session: "forged.token", transcript: [{ role: "user", content: "Where is ORD-101?" }] }));
  assert.equal(forged.status, 400);

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

test("recap: safe text removes contact details but keeps authorised order IDs", () => {
  const allowed = new Set(["ORD-101"]);
  assert.equal(
    safeRecapText("Email a@b.com, call 98765 43210 about ORD-101 and ORD-201", allowed),
    "Email [email], call [number] about ORD-101 and an unverified order",
  );
  assert.equal(safeRecapText("Use sk-abcdefghijklmnop now", allowed), "Use [secret] now");
});
